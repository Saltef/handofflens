"use strict";

// Conformal selection for FALSE DISCOVERY RATE control (Jin & Candes 2023,
// "Selection by Prediction with Conformal p-values").
//
// The decision this targets: an auto-accept / route-to-review gate. The consumer
// trusts the ACCEPTED (selected) set, so the quantity that matters is the purity
// of that set -- the false discovery rate:
//
//     FDR = E[ (selected AND truly unsupported) / (selected) ]
//
// This is the decision-relevant guarantee, unlike the marginal false-acceptance
// rate that plain threshold-CRC controls (see conformal-risk-control.js). The two
// differ whenever coverage < 100%.
//
// Method: calibration items carry a construction-true label supported:boolean and
// a support score s (higher = more supported). The null hypothesis for a test
// item is "unsupported". For each test item we build a one-sided conformal
// p-value from the calibration NULLS (truly-unsupported calibration items):
//
//     p_j = (1 + #{ i in cal_nulls : s_i >= s_j }) / (n_nulls + 1)
//
// For a genuinely unsupported (null) test item exchangeable with the calibration
// nulls, p_j is super-uniform, so it is a valid p-value; a high-scoring supported
// item gets a small p_j. Benjamini-Hochberg at level q on these p-values then
// selects the accepted set. Under exchangeability the conformal p-values are
// PRDS, so BH controls FDR at q (Jin & Candes, Thm. 1-2).

function conformalPValues(testScores, calNullScores) {
  const nNull = calNullScores.length;
  if (!nNull) throw new Error("no calibration nulls (need some truly-unsupported calibration items)");
  return testScores.map((sj) => {
    let ge = 0;
    for (const si of calNullScores) if (si >= sj) ge += 1; // ties counted -> conservative
    return (1 + ge) / (nNull + 1);
  });
}

// Benjamini-Hochberg step-up at level q. Returns the set of selected indices.
function benjaminiHochberg(pvals, q) {
  const m = pvals.length;
  if (!m) return { selected: [], kmax: 0, threshold: 0 };
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let kmax = 0;
  for (let k = 1; k <= m; k += 1) {
    if (order[k - 1].p <= (q * k) / m) kmax = k;
  }
  const threshold = kmax > 0 ? order[kmax - 1].p : -1;
  const selected = [];
  for (let i = 0; i < m; i += 1) if (pvals[i] <= threshold) selected.push(i);
  return { selected, kmax, threshold };
}

// Select the accepted set from a labeled calibration split and a test split,
// controlling FDR at q. Test labels are used only to report realized FDR/power.
function selectByFdr(calItems, testItems, q) {
  const calNullScores = calItems.filter((it) => !it.supported).map((it) => it.score);
  const pvals = conformalPValues(testItems.map((it) => it.score), calNullScores);
  const { selected } = benjaminiHochberg(pvals, q);
  const sel = new Set(selected);
  const selItems = testItems.filter((_, i) => sel.has(i));
  const falseDisc = selItems.filter((it) => !it.supported).length;
  const trueSupported = testItems.filter((it) => it.supported).length;
  return {
    q,
    n_test: testItems.length,
    selected: selItems.length,
    realized_fdr: selItems.length ? falseDisc / selItems.length : 0,
    power: trueSupported ? selItems.filter((it) => it.supported).length / trueSupported : null,
    coverage: testItems.length ? selItems.length / testItems.length : 0,
  };
}

module.exports = { conformalPValues, benjaminiHochberg, selectByFdr };
