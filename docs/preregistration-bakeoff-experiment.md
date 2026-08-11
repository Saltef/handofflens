# Pre-Registration — Support-Score Bake-off Under Conformal Risk Control

Experiment ID: `support-score-bakeoff-v1`
Timestamp: 2026-08-11, written before the entailment judge run completes.
Scope: HandoffLens only; self-contained synthetic construction-true pool.

## Question

Under a shared conformal-risk-control harness, which support score accepts the
most items (highest coverage) while holding the false-support rate at or below a
chosen `alpha`: a lexical overlap score, a deterministic cue-aware score, or an
LLM entailment score?

## Design

- Pool: construction-true (value, quote, label) pairs from 60 synthetic cases —
  300 supported (present facts) and 300 unsupported, the latter split into
  template distractors (negated / historical / conditional, cue-marked) and
  subtle distractors (held / completed-in-past, no cue words). 50/50 base rate is
  adversarial by design, to stress score discrimination.
- Scores: `lexical` (value-token coverage by quote), `cue_aware` (lexical, gated
  to 0 on a negation/history/conditional cue word), `entailment` (LLM judge
  probability the quote asserts the value as a current active fact; judge never
  sees the label).
- CRC: accept iff score >= lambda; loss = accepting an unsupported pair;
  case-clustered 50/50 splits, 200 seeded repeats, `alpha in {0.05, 0.10, 0.20}`.

## Predictions

| Prediction | Expected | Claim boundary |
| --- | --- | --- |
| Lexical | Near-zero coverage — fooled by every distractor (value is in the quote) | Adversarial 50/50 pool, not real prevalence |
| Cue-aware | Beats lexical on template distractors but still fooled by the two subtle kinds, so still low coverage | Brittle to phrasings outside the cue list |
| Entailment | Highest coverage at every alpha; the only score that scores subtle distractors low | Judge is itself a model; entailment score is not ground truth |
| All scores | Realized risk <= alpha (CRC validity holds regardless of score quality) | Coverage, not risk, is the differentiator |

## Claim boundary

Ranks support scores on a synthetic adversarial pool. Demonstrates method +
relative score discrimination, not real clinical support detection. The entailment
judge is a model estimate, not adjudicated truth; a real deployment must validate
the chosen score on human-labeled data. The 50/50 supported/unsupported base rate
is adversarial and depresses absolute coverage; only cross-score comparison at
fixed alpha is interpreted.
