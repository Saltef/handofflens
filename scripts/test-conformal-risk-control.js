"use strict";

// Monte-Carlo validity check for conformal-risk-control.js. No model calls.
//
// We synthesize items whose support score is informative but noisy, split
// repeatedly into calibration/test, calibrate lambda at a target alpha on
// calibration, and measure realized false-support risk on test. CRC guarantees
// E[risk] <= alpha, so the mean realized test risk across many splits must not
// exceed alpha (small Monte-Carlo slack allowed).

const { calibrateThreshold, evaluate } = require("./conformal-risk-control");

// Seeded LCG (avoid Math.random for reproducibility).
let _s = 0x9e3779b1;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function gauss() { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function clamp01(x) { return Math.min(1, Math.max(0, x)); }

// Truly-supported items score higher on average than unsupported ones, with
// overlap so the decision is non-trivial.
function makeItem() {
  const supported = rnd() < 0.6;
  const score = clamp01(supported ? 0.72 + 0.14 * gauss() : 0.38 + 0.18 * gauss());
  return { supported, score };
}

function run() {
  const ALPHAS = [0.05, 0.1, 0.2];
  const SPLITS = 400;
  const POOL = 600;
  const CAL_FRAC = 0.5;
  const failures = [];
  const rows = [];

  for (const alpha of ALPHAS) {
    let sumRisk = 0, sumCov = 0, violations = 0;
    for (let s = 0; s < SPLITS; s++) {
      const pool = Array.from({ length: POOL }, makeItem);
      const nCal = Math.floor(POOL * CAL_FRAC);
      const cal = pool.slice(0, nCal);
      const test = pool.slice(nCal);
      const { lambda } = calibrateThreshold(cal, alpha);
      const ev = evaluate(test, lambda);
      sumRisk += ev.realized_risk;
      sumCov += ev.coverage;
      if (ev.realized_risk > alpha) violations += 1;
    }
    const meanRisk = sumRisk / SPLITS;
    const meanCov = sumCov / SPLITS;
    rows.push({ alpha, meanRisk, meanCov, violationSplits: violations / SPLITS });
    // Core guarantee: mean realized risk <= alpha (allow tiny MC slack).
    if (meanRisk > alpha + 0.01) {
      failures.push(`alpha=${alpha}: mean realized risk ${meanRisk.toFixed(4)} exceeds alpha`);
    }
    // Sanity: a lower alpha should not yield HIGHER coverage.
  }
  // Monotonicity of coverage in alpha (looser risk target -> accept more).
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].meanCov + 1e-9 < rows[i - 1].meanCov) {
      failures.push(`coverage not monotone in alpha between ${rows[i - 1].alpha} and ${rows[i].alpha}`);
    }
  }

  console.log("Conformal risk control — Monte-Carlo validity (400 splits, pool 600, 50/50)");
  console.log("alpha | mean realized risk | mean coverage | frac splits over alpha");
  for (const r of rows) {
    console.log(
      `${r.alpha.toFixed(2)}  |  ${r.meanRisk.toFixed(4)}  (<= ${r.alpha})  |  ${r.meanCov.toFixed(3)}  |  ${r.violationSplits.toFixed(3)}`,
    );
  }

  if (failures.length) {
    console.error("\nFAIL:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log("\nPASS: mean realized risk <= alpha at every level; coverage monotone in alpha.");
}

run();
