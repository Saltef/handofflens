#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];
const required = [
  "README.md",
  "MODEL_CARD.md",
  "SECURITY.md",
  "LICENSE.md",
  "docs/README.md",
  "docs/SCIENTIFIC_WRITEUP.md",
  "docs/public-benchmark-results-2026-07-21.md",
  "docs/claims-register.md",
  "docs/REPRODUCIBILITY.md",
  "docs/benchmark-adapter-scoring.md",
  "docs/records-adapter-contract.md",
  "docs/data-exposure-attestation.md",
  "docs/security-checklist.md",
  "docs/archive/README.md",
  "eval/public_results_summary.json",
];
for (const file of required) if (!fs.existsSync(path.join(root, file))) failures.push(`Missing required share artifact: ${file}`);

const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
function listFilesRecursively(directory, prefix = "") {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...listFilesRecursively(absolute, relative));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

const usedGitEnumeration = git.status === 0;
const files = usedGitEnumeration
  ? String(git.stdout || "").split("\0").filter(Boolean)
  : listFilesRecursively(root);

const forbiddenNames = [
  /(^|\/)\.env($|\.)/i,
  /clinical_cases/i,
  /(^|\/)results\//i,
  /(^|\/)outputs\//i,
  /(^|\/)eval\/.*private/i,
  /(^|\/)eval\/dataset_sample_/i,
  /(^|\/)eval\/clinician_review_/i,
  /(^|\/)eval\/confirmatory_/i,
  /method-key/i
];
const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".csv", ".html", ".css", ".yml", ".yaml", ".example", ""]);
for (const relative of files) {
  const normalized = relative.replace(/\\/g, "/");
  if (forbiddenNames.some((pattern) => pattern.test(normalized)) && normalized !== ".env.example") failures.push(`Forbidden private/generated path is visible to Git: ${normalized}`);
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const stat = fs.statSync(absolute);
  if (stat.size > 2_000_000) failures.push(`Unexpectedly large Git candidate (${stat.size} bytes): ${normalized}`);
  if (!textExtensions.has(path.extname(relative).toLowerCase())) continue;
  const text = fs.readFileSync(absolute, "utf8");
  if (/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/.test(text)) failures.push(`Likely API secret in ${normalized}`);
  if (/Authorization\s*:\s*["'`]Bearer\s+[A-Za-z0-9._-]{20,}/i.test(text)) failures.push(`Likely bearer credential in ${normalized}`);
  for (const match of text.matchAll(/^(OPENROUTER_API_KEY|COHERE_API_KEY|ANTHROPIC_API_KEY)[ \t]*=[ \t]*(.*)$/gm)) {
    const value = match[2].trim();
    if (value && value !== "..." && !/^<.*>$/.test(value) && !/YOUR_|REDACTED/i.test(value)) failures.push(`Nonblank API key assignment in ${normalized}`);
  }
  if (text.includes("[**") && !normalized.startsWith("scripts/") && normalized !== "eval/pilot_reference_cases.json") failures.push(`De-identification marker suggests source-record content in ${normalized}`);
}

if (usedGitEnumeration) {
  const ignored = ["clinical_cases.csv.gz", ".env", "results/private.json", "outputs/review-packet.json", "eval/development_cases_private.json", "eval/dataset_sample_20.json"];
  for (const file of ignored) {
    const check = spawnSync("git", ["check-ignore", "-q", file], { cwd: root });
    if (check.status !== 0) failures.push(`Expected private path is not ignored: ${file}`);
  }
}

if (failures.length) {
  console.error("SHARE READINESS FAILED");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  const source = usedGitEnumeration ? "Git-visible" : "exported";
  console.log(`PASS share readiness: ${files.length} ${source} files scanned; private paths and secret patterns excluded.`);
}
