#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const portfolioMode = process.argv.includes("--portfolio");
const defaultOut = path.resolve(repoRoot, "..", portfolioMode ? "handofflens-portfolio-release" : "handofflens-clean-release");
const outArgIndex = process.argv.indexOf("--out");
const outDir = path.resolve(outArgIndex >= 0 ? process.argv[outArgIndex + 1] : defaultOut);

if (!outDir || outDir === repoRoot || repoRoot.startsWith(outDir + path.sep)) {
  throw new Error("Refusing to export into the repository root or one of its parents.");
}

const tracked = execFileSync("git", ["-C", repoRoot, "ls-files"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const forbidden = [
  /^clinical_cases/i,
  /^results\//i,
  /^outputs\//i,
  /^eval\/.*private/i,
  /^eval\/dataset_sample_/i,
  /^eval\/confirmatory_/i,
  /^eval\/clinician_review_/i,
  /^\.env$/i,
];

const portfolioDocAllowlist = new Set([
  "docs/README.md",
  "docs/SCIENTIFIC_WRITEUP.md",
  "docs/claims-register.md",
  "docs/REPRODUCIBILITY.md",
  "docs/benchmark-adapter-scoring.md",
  "docs/public-benchmark-results-2026-07-21.md",
  "docs/records-adapter-contract.md",
  "docs/data-exposure-attestation.md",
  "docs/security-checklist.md",
]);

const copied = [];
const skipped = [];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const rel of tracked) {
  const normalized = rel.replace(/\\/g, "/");
  if (forbidden.some((pattern) => pattern.test(normalized))) {
    skipped.push(rel);
    continue;
  }
  const isPortfolioDocAsset = normalized.startsWith("docs/assets/");
  const isPortfolioArchive = normalized.startsWith("docs/archive/");
  if (portfolioMode && normalized.startsWith("docs/") && !portfolioDocAllowlist.has(normalized) && !isPortfolioDocAsset && !isPortfolioArchive) {
    skipped.push(rel);
    continue;
  }

  const src = path.join(repoRoot, rel);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied.push(rel);
}

fs.writeFileSync(
  path.join(outDir, "CLEAN_EXPORT_MANIFEST.json"),
  JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      sourceCommit: execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      copiedFiles: copied.length,
      skippedTrackedFiles: skipped,
      dataBoundary:
        portfolioMode
          ? "Portfolio export generated from Git-tracked public files only. Private data and noisy exploratory docs are excluded; core validation docs and runnable code are retained."
          : "Generated from Git-tracked public files only. Private datasets, results, review packets, API keys, and ignored artifacts are excluded.",
    },
    null,
    2,
  ) + "\n",
);

console.log(`${portfolioMode ? "Portfolio" : "Clean"} release exported to: ${outDir}`);
console.log(`Copied files: ${copied.length}`);
if (skipped.length) {
  console.log(`Skipped tracked private-like files: ${skipped.length}`);
}
