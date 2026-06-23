#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = required(args.input, "--input is required");
const clustersPath = required(args.clusters, "--clusters is required to prevent near-duplicate leakage");
const excludePaths = String(args.exclude || "").split(",").map((item) => item.trim()).filter(Boolean);
const size = Number(required(args.size, "--size is required"));
const seed = String(args.seed || "confirmatory-v1");
const outPath = args.out || "eval/confirmatory_test_private.json";
const auditPath = args.audit || "results/confirmatory-cohort-audit-private.json";

const cases = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const clusterReport = JSON.parse(fs.readFileSync(clustersPath, "utf8"));
const clusterByCase = new Map((clusterReport.assignments || []).map((item) => [item.case_id, item.cluster_id]));
const excludedCases = excludePaths.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const excludedSubjects = new Set(excludedCases.map(subjectKey));
const excludedClusters = new Set(excludedCases.map((item) => clusterFor(item.case_id)).filter(Boolean));
const eligible = cases.filter((item) => !excludedSubjects.has(subjectKey(item)) && !excludedClusters.has(clusterFor(item.case_id)));
const bySubject = groupBy(eligible, subjectKey);
const subjectCandidates = Object.entries(bySubject).map(([subject, records]) => ({
  subject,
  case: [...records].sort((a, b) => seededRank(seed, a.case_id).localeCompare(seededRank(seed, b.case_id)))[0]
})).sort((a, b) => seededRank(seed, a.subject).localeCompare(seededRank(seed, b.subject)));
const selected = [];
const selectedClusters = new Set();
for (const candidate of subjectCandidates) {
  const cluster = clusterFor(candidate.case.case_id);
  if (cluster && selectedClusters.has(cluster)) continue;
  selected.push(candidate.case);
  if (cluster) selectedClusters.add(cluster);
  if (selected.length === size) break;
}
if (!Number.isInteger(size) || size < 1 || selected.length < size) throw new Error(`Requested ${size}; only ${selected.length} patient- and cluster-independent cases are available`);
const subjectHashes = selected.map((item) => sha256(`subject:${subjectKey(item)}`)).sort();
const caseHashes = selected.map((item) => sha256(`case:${item.case_id}`)).sort();
const audit = {
  generated_at: new Date().toISOString(),
  protocol_version: "1.0.0",
  sampling_unit: "subject_id",
  method: "seeded patient-level sample without replacement; one admission per subject and one case per near-duplicate cluster",
  seed_hash: sha256(seed),
  input_cases: cases.length,
  excluded_subjects: excludedSubjects.size,
  excluded_clusters: excludedClusters.size,
  eligible_subjects: subjectCandidates.length,
  selected_clusters: selectedClusters.size,
  selected_subjects: selected.length,
  selected_subject_hashes: subjectHashes,
  selected_case_hashes: caseHashes,
  cohort_content_hash: sha256(JSON.stringify(selected))
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(selected, null, 2)}\n`);
fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
console.log(`Wrote private confirmatory cohort: ${outPath}`);
console.log(`Wrote private hashed audit: ${auditPath}`);

function clusterFor(caseId) {
  const cluster = clusterByCase.get(caseId);
  if (!cluster) throw new Error(`Case ${caseId} is missing from duplicate-cluster assignments`);
  return cluster;
}

function subjectKey(item) {
  const value = String(item?.subject_id ?? "").trim();
  if (!value) throw new Error(`Case ${item?.case_id || "unknown"} is missing subject_id`);
  return value;
}

function seededRank(seedValue, subject) {
  return sha256(`${seedValue}:${subject}`);
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

function required(value, message) {
  if (value === undefined || value === "") throw new Error(message);
  return value;
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
