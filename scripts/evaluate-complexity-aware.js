#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { toProviderCompatibleSchema } = require("./schema-utils");
const { selectComplexityRoute } = require("./complexity-policy");

loadEnvFile(".env");
const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outDir = args["out-dir"] || "results/complexity-aware-development-v1";
const offset = Number(args.offset || 0);
const limit = Number(args.limit || 10);
const model = args.model || "command-a-plus-05-2026";
const policyProfile = args.policy || "high_sensitivity";
const apiKey = process.env.COHERE_API_KEY;
const canonicalSchema = JSON.parse(fs.readFileSync(path.join("eval", "schema.json"), "utf8"));
const providerSchema = toProviderCompatibleSchema(canonicalSchema);
const structuredOnlySchema = structuredSchema(providerSchema);
const summaryOnlySchema = {
  type: "object", additionalProperties: false, required: ["case_id", "two_page_summary"],
  properties: { case_id: { type: "string" }, two_page_summary: { type: "string" } }
};
const systemPrompt = fs.readFileSync(path.join("prompts", "system.md"), "utf8");
const baselinePrompt = fs.readFileSync(path.join("prompts", "clinical-extraction.md"), "utf8");

main().catch((error) => { console.error(redact(error.stack || error.message)); process.exitCode = 1; });

async function main() {
  const allCases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const cases = allCases.slice(offset, offset + limit);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`);
  if (args["dry-run"]) {
    console.log(JSON.stringify(cases.map((testCase) => ({ case_id: testCase.case_id, selection: selectComplexityRoute(testCase.discharge_summary, policyProfile), stages: selectComplexityRoute(testCase.discharge_summary, policyProfile).route === "two_stage_complex" ? ["structured_extraction", "grounded_summary"] : ["single_stage"] })), null, 2));
    return;
  }
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");
  for (const testCase of cases) await runCase(testCase);
  combineCheckpoints();
}

async function runCase(testCase) {
  const checkpoint = path.join(outDir, `${safe(testCase.case_id)}.json`);
  if (fs.existsSync(checkpoint) && !args.force) return;
  const selection = selectComplexityRoute(testCase.discharge_summary, policyProfile);
  const started = Date.now();
  try {
    let extraction, stages;
    if (selection.route === "single_stage_standard") {
      const response = await callJsonSchema(fullMessages(testCase), providerSchema, 8000, 512);
      extraction = response.value;
      validateFullExtraction(extraction, testCase.case_id);
      stages = [{ stage: "single_stage", telemetry: response.telemetry }];
    } else {
      const structured = await callJsonSchema(structuredMessages(testCase), structuredOnlySchema, 6000, 512);
      validateStructuredExtraction(structured.value, testCase.case_id);
      const summary = await callJsonSchema(summaryMessages(testCase, structured.value), summaryOnlySchema, 2500, 512);
      extraction = { ...structured.value, two_page_summary: String(summary.value.two_page_summary || "") };
      validateFullExtraction(extraction, testCase.case_id);
      stages = [{ stage: "structured_extraction", telemetry: structured.telemetry }, { stage: "grounded_summary", telemetry: summary.telemetry }];
    }
    fs.writeFileSync(checkpoint, `${JSON.stringify({ case_id: testCase.case_id, source_hash: sha256(testCase.discharge_summary), model, selection, latency_ms: Date.now() - started, stages, extraction }, null, 2)}\n`);
    console.log(`${testCase.case_id}: ${selection.route} complete`);
  } catch (error) {
    fs.writeFileSync(checkpoint, `${JSON.stringify({ case_id: testCase.case_id, source_hash: sha256(testCase.discharge_summary), model, selection, latency_ms: Date.now() - started, error: redact(error.message) }, null, 2)}\n`);
    console.error(`${testCase.case_id}: ${redact(error.message)}`);
  }
}

function fullMessages(testCase) {
  return [{ role: "system", content: systemPrompt }, { role: "user", content: `${baselinePrompt}\n\n${caseBlock(testCase)}` }];
}

function structuredMessages(testCase) {
  return [
    { role: "system", content: `${systemPrompt}\nThe requested schema intentionally excludes the narrative summary. Complete every structured field; do not attempt to write a summary.` },
    { role: "user", content: `Extract the complete structured record using exact source quotes. Scan medications, diagnoses, procedures/tests, labs, explicit follow-up, and uncertainty. Preserve timing, negation, and status. Do not infer medication changes from list absence.\n\n${caseBlock(testCase)}` }
  ];
}

function summaryMessages(testCase, structured) {
  return [
    { role: "system", content: "You are a source-grounded summarizer. Use only the supplied source and structured extraction. Do not add diagnoses, recommendations, causal claims, or medication changes that are not explicitly supported. Return the requested JSON only." },
    { role: "user", content: `Write a non-empty physician-facing narrative summary of at least 80 characters. Reconcile every statement with the source. The structured extraction is an index, not an independent authority; if it conflicts with the source, follow the source. Include supported hospitalization, course, medication changes, diagnoses, objective results, and explicit follow-up.\n\nSTRUCTURED EXTRACTION:\n${JSON.stringify(structured)}\n\n${caseBlock(testCase)}` }
  ];
}

function caseBlock(testCase) {
  return `CASE METADATA:\n${JSON.stringify({ case_id: testCase.case_id, age: testCase.age, gender: testCase.gender, admission_diagnosis: testCase.admission_diagnosis })}\n\nSOURCE DISCHARGE SUMMARY:\n${testCase.discharge_summary}`;
}

async function callJsonSchema(messages, schema, maxTokens, thinkingBudget) {
  const body = { model, messages, max_tokens: maxTokens, temperature: 0, thinking: { token_budget: thinkingBudget }, response_format: { type: "json_object", schema } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.COHERE_TIMEOUT_MS || 180000));
  try {
    const response = await fetch("https://api.cohere.com/v2/chat", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Cohere error ${response.status}: ${JSON.stringify(payload)}`);
    const text = messageText(payload);
    if (!text) throw new Error("Cohere response missing JSON text");
    return { value: JSON.parse(text), telemetry: { request_id: payload.id || null, returned_model: payload.model || model, finish_reason: payload.finish_reason || payload.message?.finish_reason || null, usage: payload.usage || null, request_hash: sha256(JSON.stringify(body)) } };
  } finally { clearTimeout(timeout); }
}

function structuredSchema(schema) {
  const copy = structuredClone(schema);
  copy.required = copy.required.filter((key) => key !== "two_page_summary");
  delete copy.properties.two_page_summary;
  return copy;
}

function validateStructuredExtraction(value, caseId) {
  const required = ["case_id", "patient_context", "medication_changes", "diagnosis_changes", "procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"];
  if (!value || typeof value !== "object") throw new Error("Structured extraction is not an object");
  for (const key of required) if (!(key in value)) throw new Error(`Structured extraction missing ${key}`);
  value.case_id = caseId;
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) if (!Array.isArray(value[key])) throw new Error(`${key} is not an array`);
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) if (!Array.isArray(value.medication_changes?.[key])) throw new Error(`medication_changes.${key} is not an array`);
}

function validateFullExtraction(value, caseId) {
  validateStructuredExtraction(value, caseId);
  if (typeof value.two_page_summary !== "string" || value.two_page_summary.trim().length < 80) throw new Error("two_page_summary must contain at least 80 characters");
}

function combineCheckpoints() {
  const files = fs.readdirSync(outDir).filter((name) => /^CASE_.*\.json$/i.test(name)).sort();
  const results = files.map((name) => JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8")));
  const summary = Object.fromEntries(["single_stage_standard", "two_stage_complex"].map((route) => { const rows = results.filter((x) => x.selection?.route === route); const completed = rows.filter((x) => !x.error).length; return [route, { attempted: rows.length, completed, failures: rows.length - completed }]; }));
  fs.writeFileSync(path.join(outDir, "combined.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), manifest: "manifest.json", summary, results }, null, 2)}\n`);
}

function manifest() {
  return {
    experiment_id: "complexity-aware-development-v1", created_at: new Date().toISOString(), cases_path: casesPath,
    cases_sha256: sha256(fs.readFileSync(casesPath)), model,
    policy: { profile: policyProfile, ordinary: "single JSON-Schema extraction", complex: "structured-only extraction followed by separately grounded summary", parameters_held_constant: { temperature: 0, thinking_budget: 512 }, note: "Complexity thresholds were developed on the first 100 cases and require validation on cases 100-499." },
    claims_boundary: "Development engineering experiment; not clinical validation or a deployable router."
  };
}

function messageText(payload) { const content = payload.message?.content; if (typeof content === "string") return content; return Array.isArray(content) ? content.map((part) => part?.text || "").join("").trim() : ""; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safe(value) { return String(value).replace(/[^a-z0-9_.-]/gi, "_"); }
function redact(value) { return String(value || "").replace(/cohere_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 1500); }
function loadEnvFile(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const s = line.trim(); if (!s || s.startsWith("#")) continue; const i = s.indexOf("="); if (i > 0 && process.env[s.slice(0, i).trim()] === undefined) process.env[s.slice(0, i).trim()] = s.slice(i + 1).trim(); } }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
