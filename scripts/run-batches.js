#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || path.join("eval", "dataset_sample_all.json");
const model = required(args.model, "--model is required");
const outDir = args["out-dir"] || path.join("results", "batches", safeName(model));
const batchSize = Number(args["batch-size"] || 25);
const start = Number(args.start || 0);
const maxCases = args.max ? Number(args.max) : undefined;
const force = Boolean(args.force);

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const end = Math.min(cases.length, maxCases === undefined ? cases.length : start + maxCases);
fs.mkdirSync(outDir, { recursive: true });

console.log(`Batch run model=${model}`);
console.log(`Cases=${casesPath} total=${cases.length} start=${start} end=${end} batchSize=${batchSize}`);
console.log(`Output=${outDir}`);

for (let offset = start; offset < end; offset += batchSize) {
  const limit = Math.min(batchSize, end - offset);
  const outPath = path.join(outDir, `batch_${String(offset).padStart(5, "0")}_${String(offset + limit - 1).padStart(5, "0")}.json`);
  if (!force && fs.existsSync(outPath)) {
    console.log(`Skip existing ${outPath}`);
    continue;
  }

  console.log(`Run offset=${offset} limit=${limit}`);
  const child = spawnSync(
    process.execPath,
    [
      path.join("scripts", "evaluate-models.js"),
      "--models", model,
      "--cases", casesPath,
      "--offset", String(offset),
      "--limit", String(limit),
      "--out", outPath
    ],
    { stdio: "inherit", shell: false, env: process.env }
  );
  if (child.status !== 0) {
    console.error(`Batch failed offset=${offset} limit=${limit}. Completed prior batch files remain in ${outDir}.`);
    process.exitCode = child.status || 1;
    break;
  }
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "_");
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
