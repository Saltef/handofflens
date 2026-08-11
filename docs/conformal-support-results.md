# Conformal Risk Control on the Support Decision — Results

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

## Result — CRC holds risk at or below the target on construction-true labels

| alpha | mean realized risk | mean coverage | supported recall | false-support among accepted | median lambda |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.05 | 0.030 | 0.908 | 1.000 | 0.033 | 0.667 |
| 0.10 | 0.078 | 0.958 | 1.000 | 0.081 | 0.500 |
| 0.20 | 0.121 | 1.000 | 1.000 | 0.121 | 0.000 |

Realized test risk is at or below alpha at all three levels, and coverage rises
monotonically with alpha (91% -> 96% -> 100%). This is a genuine distribution-free
guarantee — on this synthetic distribution — replacing the earlier hand-tuned
support threshold with a calibrated one.

## Honest caveat — the score matched the only error mode present

All 36 unsupported items were tagged `value_not_grounded`; none were
distractor-assertion errors. Command A+ handled the negated / historical /
conditional distractors well and rarely asserted them as present. Because the one
residual error mode (value not grounded in the cited quote) is exactly what the
lexical coverage score measures, the score separates supported from unsupported
almost perfectly here — which is why supported recall is 1.000 and coverage stays
high even at alpha = 0.05. This flatters the result.

A stronger test needs error modes the lexical score is blind to — chiefly
correctly-grounded-but-wrong-assertion items — which this model/dataset produced
too few of. Two follow-ups: (1) adversarially generate cases that induce
assertion errors, and (2) compare the lexical support score against an
assertion-aware or entailment-based nonconformity score under the same CRC
harness. CRC is agnostic to the score; the open question is which score gives the
best coverage at a fixed alpha.

## Where this leaves the conformal direction

- The method is implemented, unit-validated, and demonstrated on construction-true
  labels: false-support is controllable at a chosen alpha with an explicit
  coverage cost. This is the upgrade from "proxy-calibrated methods feasibility"
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
