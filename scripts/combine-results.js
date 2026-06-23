#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const outPath = required(args.out, "--out is required");
const inputPaths = (args.inputs || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!inputPaths.length) throw new Error("--inputs is required");

const reports = inputPaths.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const results = reports.flatMap((report) => report.results || []);
const first = reports[0] || {};

const combined = {
  generated_at: new Date().toISOString(),
  combined_from: inputPaths,
  cases_path: first.cases_path || null,
  case_offset: reports.length ? Math.min(...reports.map((report) => Number(report.case_offset || 0))) : 0,
  case_limit: results.length,
  cases: results.map((result) => result.case_id),
  models: Array.from(new Set(results.map((result) => result.model).filter(Boolean))),
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
    return [model, {
      cases_attempted: items.length,
      cases_completed: completed.length,
      failures: items.length - completed.length,
      failure_rate: items.length ? (items.length - completed.length) / items.length : 0,
      mean_latency_ms: mean(completed.map((item) => item.latency_ms))
    }];
  }));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
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
