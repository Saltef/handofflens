#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_all.json";
const clustersPath = args.clusters || "results/note-duplicate-clusters-private.json";
const outPath = args.out || "results/duplicate-cluster-review-private.csv";
const detailPath = args.details || "results/duplicate-cluster-review-private.md";
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const report = JSON.parse(fs.readFileSync(clustersPath, "utf8"));
const byId = new Map(cases.map((item) => [item.case_id, item]));
const groups = groupBy((report.assignments || []).filter((item) => item.cluster_size > 1), (item) => item.cluster_id);
const rows = [];
const details = ["# Manual Duplicate-Cluster Review", "", "Review all notes in each cluster. Complete the CSV; do not edit this evidence file.", ""];

for (const [clusterId, assignments] of Object.entries(groups)) {
  const members = assignments.map((item) => byId.get(item.case_id)).filter(Boolean);
  const distances = [];
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      distances.push(hamming(simhash64(members[left].discharge_summary), simhash64(members[right].discharge_summary)));
    }
  }
  rows.push({
    cluster_id: clusterId,
    cluster_size: members.length,
    case_ids: members.map((item) => item.case_id).join("|"),
    subject_ids: members.map((item) => item.subject_id).join("|"),
    min_pairwise_hamming: Math.min(...distances),
    max_pairwise_hamming: Math.max(...distances),
    decision: "",
    split_groups_if_needed: "",
    reviewer: "",
    reviewed_at: "",
    rationale: ""
  });
  details.push(`## ${clusterId}`, "", `Cases: ${members.map((item) => item.case_id).join(", ")}`, `Pairwise Hamming range: ${Math.min(...distances)}-${Math.max(...distances)}`, "");
  for (const member of members) {
    details.push(`### ${member.case_id} (subject ${member.subject_id})`, "", `SHA-256: ${sha256(String(member.discharge_summary || ""))}`, "", "```text", String(member.discharge_summary || ""), "```", "");
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, toCsv(rows));
fs.writeFileSync(detailPath, `${details.join("\n")}\n`);
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${detailPath}`);
console.log(`Clusters requiring human review: ${rows.length}`);

function toCsv(items) {
  const headers = Object.keys(items[0] || {});
  return `${headers.join(",")}\n${items.map((row) => headers.map((header) => csv(row[header])).join(",")).join("\n")}\n`;
}
function csv(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function normalize(value) { return String(value || "").toLowerCase().replace(/\[\*\*.*?\*\*\]/g, " [deid] ").replace(/\b\d+(?:\.\d+)?\b/g, " # ").replace(/[^a-z#]+/g, " ").replace(/\s+/g, " ").trim(); }
function simhash64(value) {
  const tokens = normalize(value).split(" ").filter(Boolean); const weights = Array(64).fill(0); const step = Math.max(1, Math.floor(Math.max(1, tokens.length - 2) / 1500));
  for (let index = 0; index + 2 < tokens.length; index += step) { const hash = crypto.createHash("sha256").update(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`).digest().readBigUInt64BE(0); for (let bit = 0; bit < 64; bit += 1) weights[bit] += ((hash >> BigInt(bit)) & 1n) ? 1 : -1; }
  return weights.reduce((value, weight, bit) => weight >= 0 ? value | (1n << BigInt(bit)) : value, 0n);
}
function hamming(a, b) { let value = a ^ b; let count = 0; while (value) { value &= value - 1n; count += 1; } return count; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function groupBy(items, keyFn) { const groups = {}; for (const item of items) { const key = keyFn(item); groups[key] ||= []; groups[key].push(item); } return groups; }
function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 1) { const item = argv[index]; if (!item.startsWith("--")) continue; const next = argv[index + 1]; if (!next || next.startsWith("--")) parsed[item.slice(2)] = true; else { parsed[item.slice(2)] = next; index += 1; } } return parsed; }
