#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const clustersPath = required(args.clusters, "--clusters is required");
const excludePaths = String(args.exclude || "").split(",").map((item) => item.trim()).filter(Boolean);
const manifest = JSON.parse(fs.readFileSync(args.manifest || "eval/experiment_manifest.json", "utf8"));
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const clusters = JSON.parse(fs.readFileSync(clustersPath, "utf8"));
const clusterByCase = new Map((clusters.assignments || []).map((item) => [item.case_id, item.cluster_id]));
const excluded = excludePaths.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const checks = [];
check("cohort is non-empty", cases.length > 0, `cases=${cases.length}`);
check("case IDs are unique", new Set(cases.map((item) => item.case_id)).size === cases.length);
check("subject IDs are present and unique", cases.every((item) => String(item.subject_id || "").trim()) && new Set(cases.map((item) => String(item.subject_id))).size === cases.length);
check("all cases have duplicate-cluster assignments", cases.every((item) => clusterByCase.has(item.case_id)));
check("duplicate clusters are unique within cohort", new Set(cases.map((item) => clusterByCase.get(item.case_id))).size === cases.length);
const excludedSubjects = new Set(excluded.map((item) => String(item.subject_id)));
const excludedClusters = new Set(excluded.map((item) => clusterByCase.get(item.case_id)).filter(Boolean));
check("no subject overlaps excluded development cohorts", !cases.some((item) => excludedSubjects.has(String(item.subject_id))));
check("no duplicate cluster overlaps excluded development cohorts", !cases.some((item) => excludedClusters.has(clusterByCase.get(item.case_id))));
check("frozen artifacts match manifest", Object.entries(manifest.frozen_artifacts || {}).every(([file, expected]) => sha256(fs.readFileSync(file)) === expected));
check("two frozen primary configurations are present", manifest.primary_configurations?.length === 2);
check("provider retries are disabled", manifest.primary_configurations?.every((item) => item.provider_retries_per_attempt === 0));
check("paired interleaved execution is frozen", /interleaved/i.test(manifest.execution_design?.order || ""));

for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` (${item.detail})` : ""}`);
const failed = checks.filter((item) => !item.ok);
const report = {
  generated_at: new Date().toISOString(),
  protocol_version: manifest.protocol_version,
  cases_path: casesPath,
  cases: cases.length,
  cohort_hash: sha256(Buffer.from(JSON.stringify(cases))),
  cluster_assignment_hash: sha256(Buffer.from(JSON.stringify(clusters.assignments || []))),
  excluded_files: excludePaths,
  checks
};
if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
if (failed.length) {
  console.error(`${failed.length} preflight check(s) failed`);
  process.exitCode = 1;
} else console.log(`All ${checks.length} preflight checks passed`);

function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition), detail });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function required(value, message) {
  if (!value) throw new Error(message);
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
