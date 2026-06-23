#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

loadEnvFile(".env");
const args = parseArgs(process.argv.slice(2));
const root = args.root || "results/cohere-methods-500-v3";
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outDir = args["out-dir"] || path.join(root, "judge-checkpoints");
const outPath = args.out || path.join(root, "comparative-judge.json");
const judgeModel = args["judge-model"] || process.env.JUDGE_MODEL || "openai/gpt-5-mini";
const repeatRate = Number(args["repeat-rate"] ?? 0.10);
const limit = args.limit ? Number(args.limit) : undefined;
const force = Boolean(args.force);
const cellIds = (args.cells || "json_schema_thinking_128,json_schema_thinking_512,strict_tool_thinking_512").split(",").map((item) => item.trim()).filter(Boolean);

async function main() {
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const selected = cases.slice(0, limit ?? cases.length);
  const reports = Object.fromEntries(cellIds.map((id) => [id, JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), "utf8"))]));
  const byCellAndCase = Object.fromEntries(cellIds.map((id) => [id, Object.fromEntries(reports[id].results.map((item) => [item.case_id, item]))]));
  fs.mkdirSync(outDir, { recursive: true });

  if (args["dry-run"]) {
    const bundle = buildBundle(selected[0], byCellAndCase, false);
    console.log(JSON.stringify(redactPreview(buildRequest(bundle)), null, 2));
    return;
  }

  for (const testCase of selected) {
    await runOne(testCase, byCellAndCase, false);
    if (stableUnit(testCase.case_id) < repeatRate) await runOne(testCase, byCellAndCase, true);
  }

  const files = fs.readdirSync(outDir).filter((name) => name.endsWith(".json")).sort();
  const judgments = files.map((name) => JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8")));
  const report = {
    generated_at: new Date().toISOString(), judge_model: judgeModel, source_root: root, source_cases: casesPath,
    design: "blinded comparative source-fidelity proxy with deterministic candidate randomization and a 10% reversed-order repeat",
    claims_boundary: "Development proxy only; not a substitute for independent source-fidelity annotation and not evidence of clinical safety.",
    repeat_rate: repeatRate, judgments
  };
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

async function runOne(testCase, byCellAndCase, repeat) {
  const suffix = repeat ? "repeat" : "primary";
  const checkpoint = path.join(outDir, `${safe(testCase.case_id)}-${suffix}.json`);
  if (!force && fs.existsSync(checkpoint)) return;
  const bundle = buildBundle(testCase, byCellAndCase, repeat);
  if (!bundle.candidates.length) {
    fs.writeFileSync(checkpoint, `${JSON.stringify({ case_id: testCase.case_id, repeat, error: "No successful candidates" }, null, 2)}\n`);
    return;
  }
  const started = Date.now();
  try {
    const { judgment, telemetry } = await callJudge(buildRequest(bundle));
    const record = { case_id: testCase.case_id, repeat, blind_map: bundle.blindMap, presentation_order: bundle.candidates.map((item) => item.label), latency_ms: Date.now() - started, telemetry, judgment };
    fs.writeFileSync(checkpoint, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${testCase.case_id} ${suffix}: judged ${bundle.candidates.length} candidates`);
  } catch (error) {
    const record = { case_id: testCase.case_id, repeat, blind_map: bundle.blindMap, presentation_order: bundle.candidates.map((item) => item.label), latency_ms: Date.now() - started, error: redactError(error.message) };
    fs.writeFileSync(checkpoint, `${JSON.stringify(record, null, 2)}\n`);
    console.error(`${testCase.case_id} ${suffix}: ${record.error}`);
  }
}

function buildBundle(testCase, byCellAndCase, repeat) {
  const successful = cellIds.map((cell) => ({ cell, result: byCellAndCase[cell][testCase.case_id] })).filter((item) => item.result?.extraction && !item.result.error);
  let ordered = deterministicShuffle(successful, testCase.case_id);
  if (repeat) ordered = [...ordered].reverse();
  const candidates = ordered.map((item, index) => ({ label: `OUTPUT_${String.fromCharCode(65 + index)}`, extraction: item.result.extraction, cell: item.cell }));
  return { testCase, candidates, blindMap: Object.fromEntries(candidates.map((item) => [item.label, item.cell])) };
}

function buildRequest(bundle) {
  return {
    model: judgeModel,
    max_tokens: Number(process.env.JUDGE_MAX_TOKENS || 12000),
    provider: { require_parameters: true },
    messages: [
      { role: "system", content: "You are a meticulous source-fidelity auditor. Compare structured extractions only with the supplied source document. Do not judge clinical appropriateness, harmfulness, or safety. Do not use outside medical knowledge. Treat fluent unsupported statements as errors. Return only JSON matching the schema." },
      { role: "user", content: `Audit each blinded output independently against the source. For each output, flag: unsupported facts, contradictions, incorrect relationships, omitted explicit extraction targets, and material semantic errors in the narrative summary. Every alleged error must include a short source quote when applicable and a short output quote. An omission may use an empty output quote. Rank outputs from best to worst source fidelity only after the independent audits.\n\nCASE ID: ${bundle.testCase.case_id}\n\nSOURCE DOCUMENT:\n${bundle.testCase.discharge_summary}\n\nBLINDED OUTPUTS:\n${bundle.candidates.map((item) => `${item.label}:\n${JSON.stringify(item.extraction)}`).join("\n\n")}` }
    ],
    response_format: { type: "json_schema", json_schema: { name: "comparative_source_fidelity_audit", strict: true, schema: judgmentSchema() } }
  };
}

function judgmentSchema() {
  const evidence = {
    type: "object", additionalProperties: false,
    required: ["error_type", "description", "source_quote", "output_quote"],
    properties: { error_type: { type: "string", enum: ["unsupported", "contradiction", "relationship", "omission", "summary"] }, description: { type: "string" }, source_quote: { type: "string" }, output_quote: { type: "string" } }
  };
  return {
    type: "object", additionalProperties: false, required: ["case_id", "audits", "ranking", "ranking_rationale"],
    properties: {
      case_id: { type: "string" },
      audits: { type: "array", items: { type: "object", additionalProperties: false, required: ["output_label", "unsupported_count", "contradiction_count", "relationship_error_count", "explicit_target_omission_count", "summary_semantic_error", "evidence"], properties: { output_label: { type: "string" }, unsupported_count: { type: "integer" }, contradiction_count: { type: "integer" }, relationship_error_count: { type: "integer" }, explicit_target_omission_count: { type: "integer" }, summary_semantic_error: { type: "boolean" }, evidence: { type: "array", maxItems: 12, items: evidence } } } },
      ranking: { type: "array", items: { type: "string" } }, ranking_rationale: { type: "string" }
    }
  };
}

async function callJudge(request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENROUTER_TIMEOUT_MS || 180000));
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com", "X-Title": "HandoffLens Comparative Fidelity Judge" }, body: JSON.stringify(request) });
    const body = await response.json();
    if (!response.ok) throw new Error(`OpenRouter error ${response.status}: ${JSON.stringify(body)}`);
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Judge response missing content");
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return { judgment: deriveAndValidateJudgment(parsed), telemetry: { id: body.id || null, model: body.model || judgeModel, usage: body.usage || null } };
  } finally { clearTimeout(timeout); }
}

function deriveAndValidateJudgment(judgment) {
  if (!judgment || !Array.isArray(judgment.audits)) throw new Error("Judge response missing audits");
  const seen = new Set();
  for (const audit of judgment.audits) {
    if (!audit.output_label || seen.has(audit.output_label)) throw new Error("Judge response has missing or duplicate output labels");
    seen.add(audit.output_label);
    const fields = ["unsupported_count", "contradiction_count", "relationship_error_count", "explicit_target_omission_count"];
    for (const field of fields) {
      if (!Number.isInteger(audit[field]) || audit[field] < 0) throw new Error(`Judge response has invalid ${field}`);
    }
    audit.any_semantic_error = fields.some((field) => audit[field] > 0) || audit.summary_semantic_error === true;
    audit.any_semantic_error_derivation = "OR(component_counts_gt_0, summary_semantic_error)";
  }
  return judgment;
}

function deterministicShuffle(items, key) { return [...items].map((item) => ({ item, key: sha256(`${key}|${item.cell}`) })).sort((a, b) => a.key.localeCompare(b.key)).map(({ item }) => item); }
function stableUnit(value) { return parseInt(sha256(value).slice(0, 8), 16) / 0xffffffff; }
function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function safe(value) { return String(value).replace(/[^a-z0-9_.-]/gi, "_"); }
function redactError(value) { return String(value).replace(/(discharge summary|source document).*/gis, "$1 [REDACTED]").slice(0, 1000); }
function redactPreview(request) { const copy = structuredClone(request); copy.messages[1].content = `${copy.messages[1].content.slice(0, 800)}\n[TRUNCATED]`; return copy; }
function loadEnvFile(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue; const at = trimmed.indexOf("="); if (at > 0 && process.env[trimmed.slice(0, at).trim()] === undefined) process.env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim(); } }
function parseArgs(argv) { const parsed = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2); const next = argv[i + 1]; if (!next || next.startsWith("--")) parsed[key] = true; else { parsed[key] = next; i += 1; } } return parsed; }

main().catch((error) => { console.error(redactError(error.stack || error.message)); process.exitCode = 1; });
