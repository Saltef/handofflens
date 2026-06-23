#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const args = parseArgs(process.argv.slice(2));
const limit = Number(args.limit || 5), start = Number(args.start || 0);
const outRoot = args["out-dir"] || "results/evidence-pipeline-v3-stability";
const conditions = [
  { id: "repeat_a", transform: "none" },
  { id: "repeat_b", transform: "none" },
  { id: "whitespace", transform: "whitespace" },
  { id: "rewrap", transform: "rewrap" }
];
fs.mkdirSync(outRoot, { recursive: true });
for (const condition of conditions) {
  const argv = ["scripts/evaluate-evidence-pipeline-v3.js", "--start", String(start), "--limit", String(limit), "--source-transform", condition.transform, "--out-dir", path.join(outRoot, condition.id)];
  const child = spawnSync(process.execPath, argv, { stdio: "inherit", shell: false, env: process.env });
  if (child.status !== 0) throw new Error(`${condition.id} failed with ${child.status}`);
}
const reports = Object.fromEntries(conditions.map((condition) => [condition.id, JSON.parse(fs.readFileSync(path.join(outRoot, condition.id, "combined.json"), "utf8"))]));
const baseline = reports.repeat_a.records;
const comparisons = {};
for (const condition of conditions.slice(1)) comparisons[condition.id] = compareRuns(baseline, reports[condition.id].records);
const output = { generated_at: new Date().toISOString(), limit, start, comparisons, interpretation: "Label-level stability is an automated robustness measure, not semantic correctness." };
fs.writeFileSync(path.join(outRoot, "stability-summary.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));

function compareRuns(left, right) {
  const rightByCase = Object.fromEntries(right.map((x) => [x.case_id, x]));
  const rows = left.map((a) => {
    const b = rightByCase[a.case_id], A = signatures(a.extraction), B = signatures(b?.extraction);
    const intersection = [...A].filter((x) => B.has(x)).length, union = new Set([...A, ...B]).size;
    return { case_id: a.case_id, a_items: A.size, b_items: B.size, jaccard: union ? intersection / union : 1, both_gate_pass: Boolean(a.final_gate?.valid && b?.final_gate?.valid) };
  });
  return { mean_jaccard: rows.reduce((n, x) => n + x.jaccard, 0) / rows.length, exact_match_cases: rows.filter((x) => x.jaccard === 1).length, both_gate_pass: rows.filter((x) => x.both_gate_pass).length, rows };
}
function signatures(extraction) { if (!extraction) return new Set(); const lists = [...Object.entries(extraction.medication_changes || {}).map(([key, value]) => [`medication_changes.${key}`, value]), ["diagnosis_changes.discharge", extraction.diagnosis_changes?.discharge], ["diagnosis_changes.new_or_changed", extraction.diagnosis_changes?.new_or_changed], ...["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"].map((key) => [key, extraction[key]])]; return new Set(lists.flatMap(([domain, values]) => (values || []).map((item) => `${domain}|${normalize(item.label)}`))); }
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
