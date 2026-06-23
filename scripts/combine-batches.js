#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputDir = required(args["input-dir"], "--input-dir is required");
const outPath = required(args.out, "--out is required");

const files = fs.readdirSync(inputDir)
  .filter((name) => /^batch_.*\.json$/i.test(name))
  .sort()
  .map((name) => path.join(inputDir, name));

const reports = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const results = reports.flatMap((report) => report.results || []);
const first = reports[0] || {};
const resultKeys = results.map((result) => `${result.case_id}::${result.model}`);
if (new Set(resultKeys).size !== resultKeys.length) throw new Error("Duplicate case/model results detected across batch files");
const models = Array.from(new Set(results.map((result) => result.model).filter(Boolean)));
const caseIds = Array.from(new Set(results.map((result) => result.case_id).filter(Boolean)));
const incompletePairs = caseIds.filter((caseId) => models.some((model) => !results.some((result) => result.case_id === caseId && result.model === model)));

const combined = {
  generated_at: new Date().toISOString(),
  combined_from: inputDir,
  batch_files: files,
  cases_path: first.cases_path || null,
  case_offset: reports.length ? Math.min(...reports.map((report) => Number(report.case_offset || 0))) : 0,
  case_limit: caseIds.length,
  cases: caseIds,
  models,
  execution_design: first.execution_design || null,
  pair_integrity: { complete_pairs: caseIds.length - incompletePairs.length, incomplete_pairs: incompletePairs.length, incomplete_case_ids: incompletePairs },
  summary: summarize(results),
  results
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(combined, null, 2)}\n`);
console.log(`Wrote ${outPath}`);

function summarize(results) {
  const byModel = {};
  for (const result of results) {
    byModel[result.model] ||= [];
    byModel[result.model].push(result);
  }
  return Object.fromEntries(Object.entries(byModel).map(([model, items]) => {
    const completed = items.filter((item) => !item.error);
    const firstPass = completed.filter((item) => (item.attempts || 1) === 1);
    const rawValid = completed.filter((item) => item.raw_schema_valid === true);
    const usage = completed.filter((item) => item.telemetry?.usage);
    return [model, {
      cases_attempted: items.length,
      cases_completed: completed.length,
      failures: items.length - completed.length,
      failure_rate: items.length ? (items.length - completed.length) / items.length : 0,
      completion_ci95: wilsonInterval(completed.length, items.length),
      first_pass_completed: firstPass.length,
      first_pass_completion_ci95: wilsonInterval(firstPass.length, items.length),
      raw_schema_valid: rawValid.length,
      raw_schema_valid_ci95: wilsonInterval(rawValid.length, items.length),
      normalized_or_repaired: completed.filter((item) => item.raw_schema_valid === false || (item.schema_repairs || []).length > 0).length,
      mean_latency_ms: mean(completed.map((item) => item.latency_ms)),
      usage_observed_cases: usage.length,
      total_input_tokens: sum(usage.map((item) => item.telemetry.usage.input_tokens)),
      total_output_tokens: sum(usage.map((item) => item.telemetry.usage.output_tokens))
    }];
  }));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function sum(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((total, value) => total + value, 0) : null;
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
