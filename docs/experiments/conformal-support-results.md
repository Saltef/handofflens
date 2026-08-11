# Conformal Risk Control on the Support Decision -- Results

Experiment ID: `conformal-support-v1`
Pre-registration: `docs/preregistration-conformal-experiment.md`
Run: 2026-08-11, 60 synthetic construction-true cases, Cohere Command A+
(`command-a-plus-05-2026`), temperature 0. Aggregates only; raw per-item outputs
remain local/uncommitted.

Two things had to be true for conformal to be legitimate here rather than
methods-feasibility on a proxy: (1) the labels are true by construction (planted
facts vs planted distractors), and (2) the CRC implementation actually controls
risk. The offline Monte-Carlo guard (`test-conformal-risk-control.js`) established
(2); this run establishes the applied result.

## Setup

299 present-asserted items were extracted across 60 cases; by construction 263
are supported and 36 unsupported. Support score = token coverage of an item's
`normalized_value` by its own copied `source_quote`. Accept iff score >= lambda.
Loss = accepting an unsupported item. Splits are at the case level (200 seeded
50/50 calibration/test splits).

## Result -- CRC holds risk at or below the target on construction-true labels

| alpha | mean realized risk | mean coverage | supported recall | false-support among accepted | median lambda |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.05 | 0.030 | 0.908 | 1.000 | 0.033 | 0.667 |
| 0.10 | 0.078 | 0.958 | 1.000 | 0.081 | 0.500 |
| 0.20 | 0.121 | 1.000 | 1.000 | 0.121 | 0.000 |

Metric definitions (this distinction matters):
- **realized risk** is the quantity CRC controls: the *marginal* false-acceptance
  rate = (items accepted AND unsupported) / (ALL test items). It is an
  unconditional error rate over the whole item pool.
- **false-support among accepted** is the *false discovery rate* (FDR) = (items
  accepted AND unsupported) / (accepted items). It is reported for context but is
  **not** what CRC guarantees. The marginal rate is <= the FDR whenever coverage
  < 100%, so a bound on the marginal rate does not by itself bound the FDR. The
  two columns are close here only because coverage is high (91-100%); at lower
  coverage they would diverge.

Realized (marginal) test risk is at or below alpha at all three levels, and
coverage rises monotonically with alpha (91% -> 96% -> 100%). This is a genuine
distribution-free guarantee on the *marginal* false-acceptance rate -- on this
synthetic distribution -- replacing the earlier hand-tuned support threshold with a
calibrated one. It is not a guarantee on the FDR among accepted items.

## FDR-controlled selection -- the decision-relevant guarantee

Because the gate auto-accepts items, the quantity a downstream consumer actually
experiences is the purity of the accepted set -- the false discovery rate (FDR)
among selected items, not the marginal rate. Conformal selection (Jin & Candes
2023) controls FDR directly: build a one-sided conformal p-value for each item
from the calibration nulls, then apply Benjamini-Hochberg at level q. Under
exchangeability, BH on conformal p-values controls FDR at q.

| target q | mean realized FDR | mean power (TPR among supported) | mean coverage |
| ---: | ---: | ---: | ---: |
| 0.05 | 0.000 | 0.080 | 0.073 |
| 0.10 | 0.004 | 1.000 | 0.883 |
| 0.20 | 0.012 | 1.000 | 0.892 |

Realized FDR is at or below q at every level (case-clustered, 200 splits). This is
the guarantee that matters for a review-routing gate: at q = 0.10, Command A+'s
present-asserted items are auto-accepted with a ~0.4% false discovery rate at full
power on this synthetic set. The strict q = 0.05 row is very conservative (power
0.08) -- a small-calibration-null artifact: only ~36 unsupported items exist (~18
per split), so the discrete conformal p-values step in units of ~1/19 and BH at
q = 0.05 admits almost nothing; a larger null set would smooth this. Implemented in
`scripts/conformal-selection.js` with a Monte-Carlo validity test
(`scripts/test-conformal-selection.js`). Claim boundary: FDR control on synthetic
construction-true labels; a real guarantee needs adjudicated labels.

## Honest caveat -- the score matched the only error mode present

All 36 unsupported items were tagged `value_not_grounded`; none were
distractor-assertion errors. Command A+ handled the negated / historical /
conditional distractors well and rarely asserted them as present. Because the one
residual error mode (value not grounded in the cited quote) is exactly what the
lexical coverage score measures, the score separates supported from unsupported
almost perfectly here -- which is why supported recall is 1.000 and coverage stays
high even at alpha = 0.05. This flatters the result.

A stronger test needs error modes the lexical score is blind to -- chiefly
correctly-grounded-but-wrong-assertion items -- which this model/dataset produced
too few of. Two follow-ups: (1) adversarially generate cases that induce
assertion errors, and (2) compare the lexical support score against an
assertion-aware or entailment-based nonconformity score under the same CRC
harness. CRC is agnostic to the score; the open question is which score gives the
best coverage at a fixed alpha.

## Where this leaves the conformal direction

- The method is implemented, unit-validated, and demonstrated on construction-true
  labels: the marginal false-acceptance rate (over all items) is controllable at a
  chosen alpha with an explicit coverage cost. This is the upgrade from
  "proxy-calibrated methods feasibility"
  to "real coverage on a stated distribution."
- The remaining gap to a real clinical claim is unchanged and is about data, not
  method: human-adjudicated or in-domain labels and a probability sample. Conformal
  does not remove that requirement; it becomes valid for the real setting only
  once calibrated on real labels.

## Claim boundary

Distribution-free risk control demonstrated on synthetic construction-true labels
with a lexical support score. Not adjudicated recall, semantic entailment,
clinical correctness, or population performance. The coverage/recall figures are
favorable partly because the score matches the only error mode present and must
not be read as general support-detection performance.
