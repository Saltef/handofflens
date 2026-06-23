#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { indexSource, renderIndexedSource, materializeExtraction } = require("./source-evidence-index");
const { evaluateExtraction } = require("./extraction-quality-gate");
const { toProviderCompatibleSchema } = require("./schema-utils");

loadEnvFile(".env");
const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outDir = args["out-dir"] || "results/evidence-pointer-v2-dev20";
const start = Number(args.start || 0);
const limit = Number(args.limit || 20);
const dryRun = Boolean(args["dry-run"]);
const force = Boolean(args.force);
const model = args.model || "command-a-plus-05-2026";
const timeoutMs = Number(process.env.COHERE_TIMEOUT_MS || 120000);
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const schemaPath = "eval/schema_evidence_pointer_v2.json";
const promptPath = "prompts/clinical-extraction-evidence-pointer-v2.md";
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const providerSchema = toProviderCompatibleSchema(schema);
const systemPrompt = fs.readFileSync("prompts/system.md", "utf8");
const extractionPrompt = fs.readFileSync(promptPath, "utf8");

if (!Number.isInteger(start) || !Number.isInteger(limit) || start < 0 || limit < 1 || start + limit > cases.length) throw new Error("Invalid development range");
if (!dryRun && !process.env.COHERE_API_KEY) throw new Error("Missing COHERE_API_KEY");
fs.mkdirSync(outDir, { recursive: true });

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  const selected = cases.slice(start, start + limit);
  const manifest = {
    experiment_id: "evidence-pointer-v2-development",
    created_at: new Date().toISOString(),
    status: "development_only",
    cases_path: casesPath,
    cases_sha256: sha256(fs.readFileSync(casesPath)),
    range: { start, limit },
    model,
    method: "Cohere JSON Schema; temperature 0; reasoning budget 512; max output 8000; no retries",
    source_index: "source-line-index-v1",
    schema_sha256: sha256(fs.readFileSync(schemaPath)),
    prompt_sha256: sha256(fs.readFileSync(promptPath)),
    dry_run: dryRun,
    claims_boundary: "Development architecture test; not a clinical validation or confirmatory estimate."
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);

  const records = [];
  for (const testCase of selected) {
    const source = String(testCase.discharge_summary || "");
    const index = indexSource(source);
    const outputPath = path.join(outDir, `${safeName(testCase.case_id)}.json`);
    if (!force && fs.existsSync(outputPath)) {
      records.push(JSON.parse(fs.readFileSync(outputPath, "utf8")));
      continue;
    }
    if (dryRun) {
      const record = { case_id: testCase.case_id, dry_run: true, source_sha256: sha256(source), indexed_source_sha256: sha256(renderIndexedSource(index)), source_line_count: index.segments.length };
      writeJson(outputPath, record); records.push(record); continue;
    }
    const startedAt = Date.now();
    let record;
    try {
      const response = await callCohere(testCase, index);
      const pointerExtraction = parseResponse(response.body);
      const materializedExtraction = materializeExtraction(pointerExtraction, index);
      const gate = evaluateExtraction(materializedExtraction, { source, caseId: testCase.case_id, requireEvidence: true });
      record = {
        case_id: testCase.case_id,
        success: true,
        pointer_adapter_valid: true,
        gate,
        pointer_extraction: pointerExtraction,
        extraction: materializedExtraction,
        telemetry: { provider_request_id: response.body.id || response.response.headers.get("x-request-id") || null, returned_model: response.body.model || model, finish_reason: response.body.finish_reason || response.body.message?.finish_reason || null, usage: response.body.usage || null, request_hash: response.requestHash, latency_ms: Date.now() - startedAt }
      };
    } catch (error) {
      record = { case_id: testCase.case_id, success: false, pointer_adapter_valid: false, error: sanitizeError(error), latency_ms: Date.now() - startedAt };
    }
    writeJson(outputPath, record); records.push(record);
    console.log(`${testCase.case_id}: ${record.success ? (record.gate.valid ? "PASS" : "GATE_FAIL") : "ERROR"}`);
  }
  const summary = summarize(records, manifest);
  writeJson(path.join(outDir, "combined.json"), { manifest, summary, records });
  console.log(JSON.stringify(summary, null, 2));
}

async function callCohere(testCase, index) {
  const request = {
    model,
    max_tokens: 8000,
    temperature: 0,
    thinking: { token_budget: 512 },
    response_format: { type: "json_object", schema: providerSchema },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserMessage(testCase, index) }
    ]
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.cohere.com/v2/chat", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const body = await response.json();
    if (!response.ok) throw new Error(`Cohere API error ${response.status}: ${JSON.stringify(body)}`);
    return { response, body, requestHash: sha256(JSON.stringify(request)) };
  } finally { clearTimeout(timer); }
}

function buildUserMessage(testCase, index) {
  return `${extractionPrompt}\n\nCase metadata:\n${JSON.stringify({ case_id: testCase.case_id, age: testCase.age, gender: testCase.gender, admission_diagnosis: testCase.admission_diagnosis }, null, 2)}\n\nIndexed discharge summary:\n${renderIndexedSource(index)}`;
}
function parseResponse(body) {
  const content = body.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text || "").join("") : "";
  if (!text.trim()) throw new Error("Cohere response missing JSON text");
  return JSON.parse(text.trim());
}
function summarize(records, manifest) {
  const successes = records.filter((x) => x.success);
  const passes = successes.filter((x) => x.gate?.valid);
  return { attempted: records.length, dry_run: manifest.dry_run, technical_successes: successes.length, pointer_adapter_failures: records.filter((x) => !x.dry_run && !x.pointer_adapter_valid).length, provenance_gate_passes: passes.length, provenance_gate_rate: successes.length ? passes.length / successes.length : null };
}
function sanitizeError(error) { return { name: error.name || "Error", message: String(error.message || error).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]") }; }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeName(value) { return String(value).replace(/[^a-z0-9_.-]+/gi, "_"); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
function loadEnvFile(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!match || process.env[match[1]]) continue; let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); process.env[match[1]] = value; } }
