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
  "docs/FINAL_VALIDATION_2026_06_23.md",
  "docs/PROJECT_STATUS.md",
  "docs/claims-register.md",
  "docs/conformal-routing-ongoing.md",
  "docs/REPRODUCIBILITY.md",
  "docs/data-exposure-attestation.md",
  "docs/FINAL_TESTS_BEFORE_SHARING.md",
  "docs/security-checklist.md",
  "docs/EXPERIMENT_HISTORY.md",
  "docs/candidate-first-v4-final-report.md",
  "docs/evidence-pointer-v2.md",
  "docs/pipeline-v3-final-report.md",
  "docs/PENDING_WORK.md",
  "docs/protocol-freeze.md",
  "docs/statistical-analysis-plan.md",
  "docs/experiment-runbook.md",
  "docs/safety-ablation-design.md",
  "docs/evaluation-plan.md",
  "docs/clinical-handover-evaluation.md",
  "docs/human-ai-collaboration-framework.md",
  "docs/probabilistic-model-boundaries.md",
  "docs/human-in-the-loop-map.md",
  "docs/atomic-clinician-review-protocol.md",
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
  if (portfolioMode && normalized.startsWith("docs/") && !portfolioDocAllowlist.has(normalized)) {
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
