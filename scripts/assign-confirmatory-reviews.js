#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = parseArgs(process.argv.slice(2));
const input = required(args.input, "--input is required");
const reviewers = String(required(args.reviewers, "--reviewers requires exactly two comma-separated blinded IDs")).split(",").map((item) => item.trim()).filter(Boolean);
if (reviewers.length !== 2 || new Set(reviewers).size !== 2) throw new Error("Exactly two distinct primary reviewer IDs are required");
const doubleFraction = Number(args.double || 0.20);
if (!(doubleFraction >= 0.20 && doubleFraction <= 1)) throw new Error("--double must be between 0.20 and 1.00");
const seed = String(args.seed || "confirmatory-review-v1");
const outDir = args["out-dir"] || "results/confirmatory-review-assignments";
const packet = JSON.parse(fs.readFileSync(input, "utf8"));
const cases = [...(packet.cases || [])].sort((a, b) => rank(seed, a.case_id).localeCompare(rank(seed, b.case_id)));
const doubleN = Math.ceil(cases.length * doubleFraction);
const doubled = new Set(cases.slice(0, doubleN).map((item) => item.case_id));
const assigned = Object.fromEntries(reviewers.map((reviewer) => [reviewer, []]));
let cursor = 0;
for (const item of cases) {
  if (doubled.has(item.case_id)) for (const reviewer of reviewers) assigned[reviewer].push(item);
  else { assigned[reviewers[cursor % 2]].push(item); cursor += 1; }
}
fs.mkdirSync(outDir, { recursive: true });
for (const reviewer of reviewers) {
  const output = { ...packet, generated_at: new Date().toISOString(), reviewer_id: reviewer, assignment: { seed_hash: sha256(seed), double_fraction: doubleFraction, model_identity_blinded: true }, cases: assigned[reviewer] };
  fs.writeFileSync(path.join(outDir, `${safe(reviewer)}.json`), `${JSON.stringify(output, null, 2)}\n`);
}
const manifest = {
  generated_at: new Date().toISOString(), seed_hash: sha256(seed), source_packet_hash: sha256(fs.readFileSync(input)),
  patient_cases: cases.length, primary_reviewers: reviewers, double_fraction: doubleFraction, double_annotated_cases: doubled.size,
  rule: "Both blinded outputs for a patient remain together. Non-overlap cases are balanced between primary reviewers.",
  assignments: Object.fromEntries(reviewers.map((reviewer) => [reviewer, assigned[reviewer].map((item) => sha256(`case:${item.case_id}`))]))
};
fs.writeFileSync(path.join(outDir, "assignment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Assigned ${cases.length} paired cases; ${doubled.size} (${(doubled.size / cases.length * 100).toFixed(1)}%) double annotated`);

function rank(seedValue, id) { return sha256(`${seedValue}:${id}`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safe(value) { return value.replace(/[^a-z0-9_-]+/gi, "_"); }
function required(value, message) { if (!value) throw new Error(message); return value; }
function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 1) { const item = argv[index]; if (!item.startsWith("--")) continue; const next = argv[index + 1]; if (!next || next.startsWith("--")) parsed[item.slice(2)] = true; else { parsed[item.slice(2)] = next; index += 1; } } return parsed; }
