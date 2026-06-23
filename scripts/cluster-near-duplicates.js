#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || "eval/dataset_sample_all.json";
const outPath = args.out || "results/note-duplicate-clusters-private.json";
const maxHamming = Number(args.hamming || 10);
const cases = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const fingerprints = cases.map((item, index) => ({
  index,
  case_id: item.case_id,
  subject_id: String(item.subject_id || item.case_id),
  exact_hash: sha256(normalize(item.discharge_summary)),
  simhash: simhash64(item.discharge_summary)
}));

const parent = fingerprints.map((_, index) => index);
const find = (value) => parent[value] === value ? value : (parent[value] = find(parent[value]));
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
};

const exact = groupBy(fingerprints, (item) => item.exact_hash);
for (const group of Object.values(exact)) for (let index = 1; index < group.length; index += 1) union(group[0].index, group[index].index);

const buckets = {};
for (const item of fingerprints) {
  for (let band = 0; band < 8; band += 1) {
    const key = `${band}:${Number((item.simhash >> BigInt(band * 8)) & 255n)}`;
    buckets[key] ||= [];
    buckets[key].push(item);
  }
}
const compared = new Set();
for (const bucket of Object.values(buckets)) {
  if (bucket.length > 200) continue;
  for (let left = 0; left < bucket.length; left += 1) {
    for (let right = left + 1; right < bucket.length; right += 1) {
      const a = bucket[left];
      const b = bucket[right];
      const pair = a.index < b.index ? `${a.index}:${b.index}` : `${b.index}:${a.index}`;
      if (compared.has(pair)) continue;
      compared.add(pair);
      if (hamming(a.simhash, b.simhash) <= maxHamming) union(a.index, b.index);
    }
  }
}

const rootGroups = groupBy(fingerprints, (item) => String(find(item.index)));
const assignments = [];
let clusterNumber = 0;
for (const group of Object.values(rootGroups).sort((a, b) => a[0].case_id.localeCompare(b[0].case_id))) {
  const clusterId = `CLUSTER_${String(++clusterNumber).padStart(5, "0")}`;
  for (const item of group) assignments.push({ case_id: item.case_id, subject_id: item.subject_id, cluster_id: clusterId, cluster_size: group.length });
}
const multi = Object.values(rootGroups).filter((group) => group.length > 1);
const report = {
  generated_at: new Date().toISOString(),
  input: inputPath,
  method: "normalized exact hash plus 64-bit word-trigram SimHash with 8x8-bit candidate bands",
  max_hamming_distance: maxHamming,
  caution: "Approximate candidate-generation audit; manually inspect multi-case clusters before freezing partitions.",
  cases: cases.length,
  clusters: rootGroups ? Object.keys(rootGroups).length : 0,
  multi_case_clusters: multi.length,
  cases_in_multi_case_clusters: multi.reduce((sum, group) => sum + group.length, 0),
  assignments: assignments.sort((a, b) => a.case_id.localeCompare(b.case_id))
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${outPath}`);
console.log(`Cases=${report.cases} clusters=${report.clusters} multi-case clusters=${report.multi_case_clusters}`);

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\[\*\*.*?\*\*\]/g, " [deid] ").replace(/\b\d+(?:\.\d+)?\b/g, " # ").replace(/[^a-z#]+/g, " ").replace(/\s+/g, " ").trim();
}

function simhash64(value) {
  const tokens = normalize(value).split(" ").filter(Boolean);
  const weights = Array(64).fill(0);
  const step = Math.max(1, Math.floor(Math.max(1, tokens.length - 2) / 1500));
  for (let index = 0; index + 2 < tokens.length; index += step) {
    const digest = crypto.createHash("sha256").update(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`).digest();
    const hash = digest.readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit += 1) weights[bit] += ((hash >> BigInt(bit)) & 1n) ? 1 : -1;
  }
  return weights.reduce((value, weight, bit) => weight >= 0 ? value | (1n << BigInt(bit)) : value, 0n);
}

function hamming(a, b) {
  let value = a ^ b;
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
  }
  return groups;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[item.slice(2)] = true;
    else {
      parsed[item.slice(2)] = next;
      index += 1;
    }
  }
  return parsed;
}
