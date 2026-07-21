#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { evaluateExtraction } = require("./extraction-quality-gate");
const { planRecovery } = require("./recovery-policy");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const resultsPath = required(args.results, "--results is required");
const outPath = required(args.out, "--out is required");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const sourceByCase = Object.fromEntries(cases.map((item) => [item.case_id, item]));
const report = JSON.parse(fs.readFileSync(resultsPath, "utf8"));

const gated = (report.results || []).map((row) => {
  const sourceCase = sourceByCase[row.case_id];
  let gate;
  if (!sourceCase) gate = syntheticFailure("source_case_missing", "Source case was not found");
  else if (row.error || !row.extraction) gate = syntheticFailure("first_pass_extraction_failure", row.error || "Extraction missing");
  else gate = evaluateExtraction(row.extraction, { caseId: row.case_id, source: sourceCase.discharge_summary });
  return {
    case_id: row.case_id,
    model: row.model,
    first_pass_technical_success: Boolean(!row.error && row.extraction),
    gate,
    recovery: planRecovery(gate),
    original_result_reference: { request_started_at: row.request_started_at || null, provider_request_id: row.telemetry?.provider_request_id || null, request_hash: row.telemetry?.request_hash || null }
  };
});

const actions = countBy(gated.map((item) => item.recovery.action));
const output = {
  generated_at: new Date().toISOString(),
  gate_version: "extraction-quality-gate-v1",
  recovery_policy_version: "explicit-recovery-policy-v1",
  source_cases: casesPath,
  source_results: resultsPath,
  summary: {
    attempted: gated.length,
    first_pass_technical_success: gated.filter((item) => item.first_pass_technical_success).length,
    gate_passed: gated.filter((item) => item.gate.valid).length,
    gate_failed: gated.filter((item) => !item.gate.valid).length,
    recovery_actions: actions
  },
  results: gated
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.summary, null, 2));
console.log(`Wrote ${outPath}`);
if (args["fail-on-invalid"] && output.summary.gate_failed) process.exitCode = 1;

function syntheticFailure(code, message) {
  return { gate_version: "extraction-quality-gate-v1", valid: false, blocking: [{ code, path: "$", message, details: null }], warnings: [], extraction_hash: null };
}
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length])); }
function required(value, message) { if (!value) throw new Error(message); return value; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
