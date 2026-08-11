# Pre-Registration -- Conformal Risk Control on the Support Decision

Experiment ID: `conformal-support-v1`
Timestamp: 2026-08-11, written before analyzing any extraction outputs.
Scope: HandoffLens only. Fully synthetic construction-true cases; self-contained,
no external-product data or dependency.

## Question

Can conformal risk control (CRC) calibrate the "accept this extracted item as a
present, supported fact" threshold so the false-support rate is controlled at a
chosen level `alpha`, on labels that are true by construction?

## Design

- Cases: 60 synthetic discharge summaries from `generate-synthetic-gold.js`. Each
  plants present facts (value appears verbatim in one sentence = gold span) plus
  three distractors (negated / historical / conditional) whose values also appear
  but must not be accepted as present.
- Model: Cohere Command A+ (`command-a-plus-05-2026`), temperature 0, extracts
  items with `assertion` and a copied `source_quote`. Only `assertion=present`
  items are candidates for acceptance.
- Support score `s` in [0,1] = token coverage of the item's `normalized_value` by
  its own `source_quote` (a model-derived lexical support signal).
- Construction-true label: `supported = true` iff the item is grounded in a
  present gold sentence and its value is covered by that sentence; otherwise
  `unsupported`, tagged by reason (distractor kind, value-not-grounded, non-gold).
- CRC: accept iff `s >= lambda`; loss = accepting an unsupported item; calibrate
  `lambda` on a calibration split, evaluate realized risk on a held-out split.
- Splitting is at the **case** level (all items from a case go to the same side)
  to respect within-case exchangeability. Report mean over 200 seeded case splits
  at `alpha in {0.05, 0.10, 0.20}`.

## Predictions

| Prediction | Expected | Claim boundary |
| --- | --- | --- |
| CRC validity | Mean realized test risk <= alpha at every level | On the synthetic distribution only |
| Coverage/alpha | Coverage (accept rate) rises monotonically with alpha | Utility side, not correctness |
| Score is imperfect | Some high-score items are unsupported (distractors grounded on their own sentence), so CRC must abstain to hold low alpha | Motivates an assertion-aware / entailment score |
| Dominant false-support reason | Negated/historical distractors, not hallucination, drive residual false accepts | Reason tags are descriptive |

## Claim boundary

CRC gives distribution-free control **only for the distribution it is calibrated
on**. Here that distribution is synthetic and construction-labeled, so a valid
result demonstrates the method and the score's ceiling, not real clinical
coverage, adjudicated recall, or population performance. Moving to a real
guarantee requires human-adjudicated or in-domain labeled data.
