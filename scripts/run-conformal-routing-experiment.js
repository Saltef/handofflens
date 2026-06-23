#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases || "eval/dataset_sample_representative_500.json", "--cases is required");
const resultsPath = required(args.results, "--results is required");
const outPrefix = args["out-prefix"] || path.join("results", "conformal-routing");
const alpha = args.alpha || "0.10";
const repeats = args.repeats || "50";
const minGroupCalibration = args["min-group-calibration"] || "8";

const routingPath = `${outPrefix}-routing.json`;
const conformalPath = `${outPrefix}-conformal.json`;

run("Routing labels", [
  "scripts/analyze-routing.js",
  "--cases", casesPath,
  "--results", resultsPath,
  "--out", routingPath
]);

run("Overlapping group conformal", [
  "scripts/run-overlapping-group-conformal.js",
  "--cases", casesPath,
  "--routing", routingPath,
  "--alpha", alpha,
  "--repeats", repeats,
  "--min-group-calibration", minGroupCalibration,
  "--out", conformalPath
]);

console.log(`\nExperiment complete.`);
console.log(`Routing analysis: ${routingPath}`);
console.log(`Conformal analysis: ${conformalPath}`);
console.log(`Markdown reports: ${routingPath.replace(/\.json$/i, ".md")} and ${conformalPath.replace(/\.json$/i, ".md")}`);

function run(label, commandArgs) {
  console.log(`\n=== ${label} ===`);
  const child = spawnSync(process.execPath, commandArgs, { stdio: "inherit", shell: false, env: process.env });
  if (child.status !== 0) process.exit(child.status || 1);
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
