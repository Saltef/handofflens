"use strict";

// Monte-Carlo validity check for conformal-selection.js (FDR control). No model
// calls. Synthesizes items with an informative-but-noisy support score, splits
// calibration/test repeatedly, selects at level q, and measures realized FDR on
// the test split. Jin & Candes guarantees E[FDR] <= q, so the mean realized FDR
// across splits must not exceed q (small Monte-Carlo slack allowed). Also checks
// that power (selection of true supported) rises with q.

const { selectByFdr } = require("./conformal-selection");

let _s = 0x2f6b1d3;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clamp01(x) { return Math.min(1, Math.max(0, x)); }

function makeItem() {
  const supported = rnd() < 0.5;
  const score = clamp01(supported ? 0.70 + 0.16 * gauss() : 0.35 + 0.18 * gauss());
  return { supported, score };
}

function run() {
  const QS = [0.05, 0.1, 0.2];
  const SPLITS = 500;
  const POOL = 600;
  const MC_TOL = 0.02; // BH/conformal FDR is finite-sample noisy at these sizes
  const failures = [];
  const rows = [];

  for (const q of QS) {
    let sumFdr = 0, sumPow = 0, sumCov = 0, n = 0;
    for (let s = 0; s < SPLITS; s += 1) {
      const pool = Array.from({ length: POOL }, makeItem);
      const nCal = Math.floor(POOL / 2);
      const r = selectByFdr(pool.slice(0, nCal), pool.slice(nCal), q);
      sumFdr += r.realized_fdr; sumCov += r.coverage;
      if (r.power != null) sumPow += r.power;
      n += 1;
    }
    const meanFdr = sumFdr / n, meanPow = sumPow / n, meanCov = sumCov / n;
    rows.push({ q, meanFdr, meanPow, meanCov });
    if (meanFdr > q + MC_TOL) failures.push(`q=${q}: mean realized FDR ${meanFdr.toFixed(4)} exceeds target by > ${MC_TOL}`);
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].meanPow + 1e-9 < rows[i - 1].meanPow) failures.push(`power not monotone in q between ${rows[i - 1].q} and ${rows[i].q}`);
  }

  console.log("Conformal selection -- FDR control Monte-Carlo (500 splits, pool 600, 50/50)");
  console.log("q(target) | mean realized FDR | mean power (TPR) | mean coverage");
  for (const r of rows) {
    const d = r.meanFdr - r.q;
    console.log(`${r.q.toFixed(2)}  |  ${r.meanFdr.toFixed(4)} (${d >= 0 ? "+" : ""}${d.toFixed(4)} vs target, MC tol ${MC_TOL})  |  ${r.meanPow.toFixed(3)}  |  ${r.meanCov.toFixed(3)}`);
  }

  if (failures.length) {
    console.error("\nFAIL:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS: mean realized FDR <= target q within Monte-Carlo tolerance; power monotone in q.");
}

run();
