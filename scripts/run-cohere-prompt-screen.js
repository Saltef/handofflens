#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outRoot = args["out-dir"] || "results/cohere-prompt-screen-100-v1";
const start = Number(args.start || 0);
const maxCases = Number(args.max || 100);
const prompts = [
  { id: "prompt_baseline", file: "prompts/clinical-extraction.md" },
  { id: "prompt_evidence_first", file: "prompts/clinical-extraction-evidence-first.md" },
  { id: "prompt_coverage_checklist", file: "prompts/clinical-extraction-coverage-checklist.md" }
];
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
if (start + maxCases > cases.length) throw new Error("Requested prompt-screen range exceeds the case file");
fs.mkdirSync(outRoot, { recursive: true });
const manifestPath = path.join(outRoot, "manifest.json");
if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, `${JSON.stringify({ experiment_id: "cohere-prompt-screen-100-v1", created_at: new Date().toISOString(), status: "development_prompt_screen", cases_path: casesPath, cases_sha256: sha256(fs.readFileSync(casesPath)), start, case_count: maxCases, fixed_model: "command-a-plus-05-2026", fixed_method: "JSON Schema, reasoning budget 512, temperature 0", prompts: prompts.map((item) => ({ ...item, sha256: sha256(fs.readFileSync(item.file)) })), selection_rule: ["Exclude prompts with valid-output rate more than 2 percentage points below the best prompt", "Among remaining prompts, minimize LLM-judge any-semantic-error rate", "Break ties by fewer total judged errors, then median latency"], claims_boundary: "Development prompt optimization using an automated proxy; not clinical validation." }, null, 2)}\n`);

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  for (let offset = start; offset < start + maxCases; offset += 1) await Promise.all(prompts.map((prompt) => runPrompt(prompt, offset)));
  for (const prompt of prompts) {
    const dir = path.join(outRoot, prompt.id), env = environment(prompt);
    runSync(["scripts/combine-batches.js", "--input-dir", dir, "--out", path.join(outRoot, `${prompt.id}.json`)], env);
    runSync(["scripts/summarize-batches.js", "--input-dir", dir, "--out", path.join(outRoot, `${prompt.id}.md`)], env);
  }
}

function runPrompt(prompt, offset) {
  const argv = ["scripts/run-batches.js", "--model", "cohere-json-schema:command-a-plus-05-2026", "--cases", casesPath, "--batch-size", "1", "--out-dir", path.join(outRoot, prompt.id), "--start", String(offset), "--max", "1"];
  return new Promise((resolve, reject) => { const child = spawn(process.execPath, argv, { stdio: "inherit", shell: false, env: environment(prompt) }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${prompt.id} exited ${code}`))); });
}
function environment(prompt) { return { ...process.env, EXPERIMENT_MODE: "exploratory", EXTRACTION_PROMPT_PATH: prompt.file, COHERE_RETRIES: "0", COHERE_VALIDATION_RETRIES: "0", COHERE_TEMPERATURE: "0", COHERE_THINKING_BUDGET: "512", COHERE_MAX_TOKENS: "8000" }; }
function runSync(argv, env) { const child = spawnSync(process.execPath, argv, { stdio: "inherit", shell: false, env }); if (child.status !== 0) throw new Error(`${argv[0]} exited ${child.status}`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
