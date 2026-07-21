#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = required(args.input, "--input is required");
const outPath = args.out || "results/recovery-ablation.json";
const report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const byModel = groupBy(report.results || [], (item) => item.model);
const models = {};

for (const [model, rows] of Object.entries(byModel)) {
  const successful = rows.filter((row) => !row.error);
  const firstPass = successful.filter((row) => (row.attempts || 1) === 1);
  const recovered = successful.filter((row) => (row.attempts || 1) > 1);
  const unresolved = rows.filter((row) => row.error);
  const allAttempts = rows.flatMap((row) => row.attempt_audit || []);
  const fallbackRecovered = recovered.filter((row) => /strict/i.test(row.route_model || ""));
  models[model] = {
    cases: rows.length,
    first_pass_success: firstPass.length,
    first_pass_success_rate: rate(firstPass.length, rows.length),
    policy_assisted_success: successful.length,
    policy_assisted_success_rate: rate(successful.length, rows.length),
    incremental_recovered_cases: recovered.length,
    strict_fallback_recovered_cases: fallbackRecovered.length,
    unresolved_cases: unresolved.length,
    raw_schema_valid_final_outputs: successful.filter((row) => row.raw_schema_valid === true).length,
    normalized_or_repaired_final_outputs: successful.filter((row) => row.raw_schema_valid === false || (row.schema_repairs || []).length > 0).length,
    total_provider_calls: allAttempts.length,
    failed_attempts: allAttempts.filter((attempt) => attempt.status === "failure").length,
    mean_latency_ms_all_cases: mean(rows.map((row) => row.latency_ms)),
    mean_latency_ms_recovered_cases: mean(recovered.map((row) => row.latency_ms)),
    recovery_attempt_input_tokens: sum(allAttempts.filter((attempt) => attempt.attempt > 1).map((attempt) => attempt.telemetry?.usage?.input_tokens)),
    recovery_attempt_output_tokens: sum(allAttempts.filter((attempt) => attempt.attempt > 1).map((attempt) => attempt.telemetry?.usage?.output_tokens))
  };
}

const output = {
  generated_at: new Date().toISOString(),
  input: inputPath,
  interpretation: "Descriptive nested recovery-policy ablation. It estimates technical rescue and added burden; it does not prove improved clinical accuracy.",
  models
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outPath}`);

function rate(numerator, denominator) { return denominator ? numerator / denominator : null; }
function mean(values) { const finite = values.filter(Number.isFinite); return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null; }
function sum(values) { const finite = values.filter(Number.isFinite); return finite.length ? finite.reduce((total, value) => total + value, 0) : 0; }
function groupBy(items, fn) { const out = {}; for (const item of items) { const key = fn(item); out[key] ||= []; out[key].push(item); } return out; }
function required(value, message) { if (!value) throw new Error(message); return value; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2); const next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
