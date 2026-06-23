#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputDir = required(args["input-dir"], "--input-dir is required");
const outPath = args.out || path.join(inputDir, "summary.md");

const files = fs.readdirSync(inputDir)
  .filter((name) => /^batch_.*\.json$/i.test(name))
  .sort()
  .map((name) => path.join(inputDir, name));

const results = [];
for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const result of report.results || []) {
    results.push({ ...result, batch_file: file });
  }
}

const completed = results.filter((item) => !item.error);
const failed = results.filter((item) => item.error);
const latencies = completed.map((item) => item.latency_ms).sort((a, b) => a - b);
const errors = countBy(failed.map((item) => classifyError(item.error)));

const lines = [
  "# Batch Summary",
  "",
  `Input directory: \`${inputDir}\``,
  `Batch files: ${files.length}`,
  `Cases attempted: ${results.length}`,
  `Cases completed: ${completed.length}`,
  `Cases failed: ${failed.length}`,
  `Failure rate: ${format(results.length ? failed.length / results.length : 0)}`,
  `Mean latency ms: ${Math.round(mean(latencies))}`,
  `P50 latency ms: ${Math.round(percentile(latencies, 0.50))}`,
  `P90 latency ms: ${Math.round(percentile(latencies, 0.90))}`,
  "",
  "## Error Classes",
  "",
  "| Error Class | Count |",
  "| --- | ---: |"
];

for (const [errorClass, count] of Object.entries(errors).sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${errorClass} | ${count} |`);
}

lines.push("", "## Failed Cases", "", "| Case | Error Class | Error |", "| --- | --- | --- |");
for (const item of failed) {
  lines.push(`| ${item.case_id} | ${classifyError(item.error)} | ${escapeTable(item.error)} |`);
}

fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${outPath}`);

function classifyError(error) {
  const text = String(error || "").toLowerCase();
  if (text.includes("timed out")) return "timeout";
  if (text.includes("invalid_tool_generation")) return "invalid_tool_generation";
  if (text.includes("fetch failed")) return "network_fetch_failed";
  if (text.includes("max_tokens") || text.includes("max tokens") || text.includes("output length")) return "max_tokens_limit";
  if (text.includes("schema mismatch")) return "schema_mismatch";
  if (text.includes("json") || text.includes("parse")) return "json_parse";
  if (text.includes("429") || text.includes("rate limit") || text.includes("rate_limit") || text.includes("too many requests")) return "rate_limit";
  if (text.includes("missing tool call")) return "missing_tool_call";
  if (text.includes("500") || text.includes("internal server")) return "provider_5xx";
  if (text.includes("400")) return "provider_4xx";
  if (text.includes("missing")) return "missing_response";
  return "other";
}

function countBy(items) {
  const counts = {};
  for (const item of items) counts[item] = (counts[item] || 0) + 1;
  return counts;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index];
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 240);
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
