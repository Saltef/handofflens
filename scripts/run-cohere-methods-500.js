#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outRoot = args["out-dir"] || "results/cohere-methods-500-v3";
const maxCases = Number(args.max || 500);
const start = Number(args.start || 0);
const batchSize = Number(args["batch-size"] || 1);
const force = Boolean(args.force);
const experimentId = args["experiment-id"] || "cohere-methods-500-v3";

const cells = [
  {
    id: "json_schema_thinking_128",
    model: "cohere-json-schema:command-a-plus-05-2026",
    request: { response_format: "json_schema", thinking_token_budget: 128, temperature: 0 }
  },
  {
    id: "json_schema_thinking_512",
    model: "cohere-json-schema:command-a-plus-05-2026",
    request: { response_format: "json_schema", thinking_token_budget: 512, temperature: 0 }
  },
  {
    id: "strict_tool_thinking_512",
    model: "cohere-strict:command-a-plus-05-2026",
    request: { strict_tools: true, thinking_token_budget: 512, temperature: 0 }
  }
];

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
if (cases.length < start + maxCases) throw new Error(`Requested ${maxCases} cases at offset ${start}, but ${casesPath} contains ${cases.length}`);
fs.mkdirSync(outRoot, { recursive: true });

const manifest = {
  experiment_id: experimentId,
  created_at: new Date().toISOString(),
  status: "engineering_proxy_experiment",
  claims_boundary: "Operational reliability and LLM-judge source-fidelity proxy only; not clinical accuracy, safety, or external validation.",
  cases_path: casesPath,
  cases_sha256: sha256(fs.readFileSync(casesPath)),
  case_count: maxCases,
  case_offset: start,
  case_ids_sha256: sha256(JSON.stringify(cases.slice(start, start + maxCases).map((item) => item.case_id))),
  extraction_prompt_path: "prompts/clinical-extraction.md",
  extraction_prompt_sha256: sha256(fs.readFileSync(path.join("prompts", "clinical-extraction.md"))),
  development_exclusion: start === 100 ? "Dataset positions 0-99 were used for prompt and workflow development and are excluded from this held-out run." : null,
  model: "command-a-plus-05-2026",
  cells,
  execution: {
    order: "case-interleaved execution; the three cells run concurrently within each case",
    batch_size: batchSize,
    provider_retries: 0,
    local_validation_retries: 0,
    checkpointing: "one immutable batch file per batch unless --force is explicitly supplied",
    primary_endpoint: "first-pass locally valid structured-output rate",
    secondary_endpoints: ["technical completion", "raw schema validity", "latency", "token use", "LLM-judge semantic-error proxy"]
  }
};
const manifestPath = path.join(outRoot, "manifest.json");
if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  for (let offset = start; offset < start + maxCases; offset += batchSize) {
    const limit = Math.min(batchSize, start + maxCases - offset);
    await Promise.all(cells.map((cell) => runCellBatch(cell, offset, limit)));
  }
  for (const cell of cells) {
    const cellDir = path.join(outRoot, cell.id);
    const env = cellEnvironment(cell);
    runNode(["scripts/combine-batches.js", "--input-dir", cellDir, "--out", path.join(outRoot, `${cell.id}.json`)], env);
    runNode(["scripts/summarize-batches.js", "--input-dir", cellDir, "--out", path.join(outRoot, `${cell.id}.md`)], env);
  }
}

function runCellBatch(cell, offset, limit) {
  const cellDir = path.join(outRoot, cell.id);
  const env = cellEnvironment(cell);
  console.log(`\n=== case offset ${offset}; ${cell.id} ===`);
  const childArgs = [
    "scripts/run-batches.js", "--model", cell.model, "--cases", casesPath,
    "--batch-size", String(limit), "--out-dir", cellDir,
    "--start", String(offset), "--max", String(limit)
  ];
  if (force) childArgs.push("--force");
  return runNodeAsync(childArgs, env);
}

function cellEnvironment(cell) {
  const env = {
    ...process.env,
    EXPERIMENT_MODE: "exploratory",
    COHERE_RETRIES: "0",
    EVAL_VALIDATION_RETRIES: "0",
    COHERE_TEMPERATURE: "0",
    COHERE_MAX_TOKENS: "8000",
    COHERE_VALIDATION_RETRIES: "0"
  };
  delete env.COHERE_THINKING;
  delete env.COHERE_THINKING_BUDGET;
  delete env.COHERE_TOOL_CHOICE;
  delete env.EXTRACTION_PROMPT_PATH;
  if (cell.request.thinking === "disabled") env.COHERE_THINKING = "disabled";
  if (cell.request.thinking_token_budget) env.COHERE_THINKING_BUDGET = String(cell.request.thinking_token_budget);
  return env;
}

function runNodeAsync(childArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { stdio: "inherit", shell: false, env });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${childArgs[0]} exited with ${code}`)));
  });
}

function runNode(childArgs, env) {
  const result = spawnSync(process.execPath, childArgs, { stdio: "inherit", shell: false, env });
  if (result.status !== 0) process.exit(result.status || 1);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else { parsed[key] = next; index += 1; }
  }
  return parsed;
}
