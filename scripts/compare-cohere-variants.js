#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const variants = [
  {
    name: "baseline-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "tool-loose", COHERE_TEMPERATURE: "0" }
  },
  {
    name: "tool-required-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "tool-loose", COHERE_TEMPERATURE: "0", COHERE_TOOL_CHOICE: "REQUIRED" }
  },
  {
    name: "tool-required-budget-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "tool-loose", COHERE_TEMPERATURE: "0", COHERE_TOOL_CHOICE: "REQUIRED", COHERE_THINKING_BUDGET: "1000" }
  },
  {
    name: "strict-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "tool-strict", COHERE_TEMPERATURE: "0" }
  },
  {
    name: "strict-budget-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "tool-strict", COHERE_TEMPERATURE: "0", COHERE_THINKING_BUDGET: "1000" }
  },
  {
    name: "strict-budget512-temp0",
    model: "cohere-strict:command-a-plus-05-2026",
    env: { COHERE_TEMPERATURE: "0" }
  },
  {
    name: "json-schema-temp0",
    model: "cohere:command-a-plus-05-2026",
    env: { COHERE_SCHEMA_MODE: "json-schema", COHERE_TEMPERATURE: "0" }
  },
  {
    name: "json-schema-budget512-temp0",
    model: "cohere-json-schema:command-a-plus-05-2026",
    env: { COHERE_TEMPERATURE: "0" }
  },
  {
    name: "aplus-routed-temp0",
    model: "cohere-aplus:command-a-plus-05-2026",
    env: { COHERE_TEMPERATURE: "0", EVAL_VALIDATION_RETRIES: "2" }
  }
];

const args = parseArgs(process.argv.slice(2));
const max = args.max || "5";
const cases = args.cases || "eval/dataset_sample_all.json";
const batchSize = args["batch-size"] || "25";
const start = args.start || "0";
const selectedVariants = args.only
  ? variants.filter((variant) => variant.name === args.only)
  : variants;

if (args.only && selectedVariants.length === 0) {
  console.error(`Unknown Cohere variant: ${args.only}`);
  process.exit(1);
}

for (const variant of selectedVariants) {
  const outDir = args["out-dir"] || `results/batches/cohere-variant-${variant.name}`;
  console.log(`\n=== Cohere variant: ${variant.name} ===`);
  const env = {
    ...process.env,
    COHERE_RETRIES: process.env.COHERE_RETRIES || "2",
    COHERE_MAX_TOKENS: process.env.COHERE_MAX_TOKENS || "8000",
    ...variant.env
  };
  const run = spawnSync(
    process.execPath,
    [
      "scripts/run-batches.js",
      "--model", variant.model,
      "--cases", cases,
      "--batch-size", batchSize,
      "--out-dir", outDir,
      "--start", start,
      "--max", max,
      "--force"
    ],
    { stdio: "inherit", env }
  );
  if (run.status !== 0) {
    console.error(`Variant ${variant.name} failed to finish runner.`);
  }
  spawnSync(
    process.execPath,
    [
      "scripts/summarize-batches.js",
      "--input-dir", outDir,
      "--out", `${outDir}-summary.md`
    ],
    { stdio: "inherit", env }
  );
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
