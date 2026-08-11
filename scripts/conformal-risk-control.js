"use strict";

// Conformal Risk Control (CRC) for the "is this extracted item supported?"
// accept decision (Angelopoulos, Bates, Fisch, Fort, Schuster, Jordan 2023,
// "Conformal Risk Control"). Distribution-free, finite-sample control of the
// expected loss on exchangeable data.
//
// Setup here: each item has a support score s in [0, 1] (higher = better
// supported) and a construction-true label supported: boolean. We ACCEPT an
// item as supported iff s >= lambda. The per-item loss is:
//
//     l_i(lambda) = 1  iff  s_i >= lambda AND NOT supported_i
//
// IMPORTANT -- what is controlled: CRC bounds E[ mean_i l_i(lambda) ], i.e. the
// expected fraction of ALL items that are wrongly accepted (a MARGINAL /
// unconditional false-acceptance rate). This is NOT the false discovery rate
// (FDR) among accepted items -- accepted-and-unsupported / accepted. The two
// coincide only at full coverage (accept everything); when some items are
// rejected the marginal rate is <= the FDR, so a marginal bound does not by
// itself bound the FDR. `evaluate()` reports both; only the marginal rate is
// guaranteed. Reviewers should read "false-acceptance rate" as the marginal
// quantity, not FDR.
//
// l_i is monotone non-increasing in lambda (raising the threshold accepts fewer
// items, so it can only remove false accepts), which is exactly the structure
// CRC requires. We pick the SMALLEST lambda (most permissive, highest coverage)
// whose corrected empirical risk is <= alpha:
//
//     lambda_hat = inf { lambda : (n * Rhat(lambda) + B) / (n + 1) <= alpha }
//
// with B = 1 the loss upper bound. The +B/(n+1) term is the finite-sample
// correction that makes E[ mean_i l_i(lambda_hat) ] <= alpha hold on a fresh
// exchangeable point.

function falseSupportLoss(item, lambda) {
  const accepted = item.score >= lambda;
  return accepted && !item.supported ? 1 : 0;
}

// Calibrate lambda on a calibration set. Returns lambda_hat and the calibration
// diagnostics. `lossFn(item, lambda)` must be a [0,1] loss, monotone
// non-increasing in lambda.
function calibrateThreshold(calibration, alpha, lossFn = falseSupportLoss) {
  const n = calibration.length;
  if (!n) throw new Error("empty calibration set");
  // Candidate thresholds: every distinct score, plus 0 and just-above-1.
  const scores = [...new Set(calibration.map((it) => it.score))].sort((a, b) => a - b);
  const candidates = [0, ...scores, 1 + 1e-9];
  // Scan from the most permissive (lambda = 0) upward; because corrected risk is
  // non-increasing in lambda, take the smallest lambda that satisfies the bound.
  let lambdaHat = 1 + 1e-9; // fully conservative fallback: accept nothing
  for (const lambda of candidates) {
    const rhat = calibration.reduce((a, it) => a + lossFn(it, lambda), 0) / n;
    const corrected = (n * rhat + 1) / (n + 1);
    if (corrected <= alpha) { lambdaHat = lambda; break; }
  }
  const rhatAt = calibration.reduce((a, it) => a + lossFn(it, lambdaHat), 0) / n;
  return { lambda: lambdaHat, calibration_risk: rhatAt, n };
}

// Evaluate a chosen lambda on a held-out test set.
function evaluate(test, lambda, lossFn = falseSupportLoss) {
  const n = test.length;
  const accepted = test.filter((it) => it.score >= lambda);
  const risk = test.reduce((a, it) => a + lossFn(it, lambda), 0) / n;
  const trueSupported = test.filter((it) => it.supported).length;
  const acceptedTrueSupported = accepted.filter((it) => it.supported).length;
  return {
    n,
    lambda,
    realized_risk: risk, // fraction of ALL items falsely accepted
    coverage: accepted.length / n, // fraction accepted
    accepted: accepted.length,
    // recall of truly-supported items among accepted (utility side)
    supported_recall: trueSupported ? acceptedTrueSupported / trueSupported : null,
    false_support_among_accepted: accepted.length ? accepted.filter((it) => !it.supported).length / accepted.length : 0,
  };
}

module.exports = { calibrateThreshold, evaluate, falseSupportLoss };
