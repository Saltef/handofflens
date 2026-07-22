# Project status

Last updated: 2026-07-22

## Executive assessment

HandoffLens is ready to share as a public engineering and research portfolio artifact. It demonstrates a clear reliability lesson: schema-valid LLM extraction can still fail source provenance, and candidate-first extraction makes that failure measurable and easier to control.

The project is not a clinical-validation study and is not a production clinical system.

## Current result

The strongest current architecture is candidate-first v4:

- deterministic candidate discovery;
- stable candidate identifiers;
- exact source quotations;
- bounded model classification;
- deterministic provenance gates;
- extractive final labels and summaries;
- abstention when evidence does not survive validation.

In the June 23 final development rerun, candidate-first v4 passed deterministic gates on 19 of 20 cases, with one abstention and no stage failures. A subsequent extractive rematerialization step reduced source-fidelity proxy issues by removing unsupported numeric details from generated summaries.

After external critique of the lexical-provenance metric, the automated semantic audit was extended with an assertion-aware context check. This catches a narrow but important class of failures where an exact source span is present but the surrounding source asserts the item as absent, possible, conditional, hypothetical, historical, or associated with someone else. This remains a proxy audit, not clinical validation.

After a fresh credential-blocked public eval attempt, the repo also includes a model-evidence validity checker. It fails runs with missing provider keys, authorization failures, row errors, zero completed cases, unscored selected rows, or provider-error attempt audits. This makes the reporting boundary enforceable: a script run can exercise the evaluation path without becoming valid model-performance evidence.

The public benchmark path now ingests the complete public ACI-Bench JSON release and the public BioScope XML files without committing corpus data. ACI-Bench is reported as an adapter and note-shape diagnostic until model-generated notes or item-level expert labels are available. BioScope is reported as a gold-label assertion benchmark with both hard-label and conformal prediction-set metrics.

## Architecture history

| Stage | Status | Public interpretation |
| --- | --- | --- |
| Structured-output baseline | Completed | Demonstrated that schema validity does not guarantee source fidelity. |
| Evidence-pointer v2 | Conservative comparator | More source-grounded than direct generation, but lower final gate yield than v4. |
| Multi-stage v3 | Rejected | More stages and recovery calls did not produce acceptable stability. |
| Candidate-first v4 | Strongest current architecture | Best engineering result so far; factual review is the next step for estimating over-extraction risk. |
| Conformal/selective routing | Ongoing appendix | Explores escalation policies using proxy labels, not clinical safety labels. |

## Evidence hierarchy

The project separates several kinds of evidence:

1. Synthetic fixtures - software mechanics only.
2. Unlabeled model runs - schema validity, completion, latency, cost, and failure modes.
3. Deterministic provenance gates - source-traceability checks.
4. LLM-as-judge outputs - proxy diagnostics for development, not truth labels.
5. Non-clinician factual review - source support, quote completeness, category consistency, and duplication.
6. Clinician review - clinical importance, harmfulness, appropriateness, and safety.
7. External validation - generalization to a new site, population, or data source.

Levels 1-4 are represented in the current public artifact. Level-5 review packets are prepared; completed human labels are not included. Levels 6-7 remain future work.

## What is supportable today

- A reproducible engineering case study of source-fidelity failure discovery.
- A candidate-first architecture for reducing unsupported generation.
- Deterministic gating, abstention, and extractive rematerialization as reliability patterns.
- Assertion-aware source-context checks as an added proxy layer beyond exact lexical containment.
- A lexical-provenance overstatement analyzer that estimates how often exact quote matches occur in non-present assertion contexts.
- A typed-provenance analyzer that separates direct quotes, supported normalization, inferential support, unsupported labels, and assertion conflicts.
- An implemented analyzer for a private adjudicated item-level gold set, so future review can report precision, recall, F1, and domain-specific over-extraction/omission patterns.
- A model-evidence validity checker that prevents missing-key, authorization-failed, or fallback-contaminated runs from being reported as model benchmarks.
- Strict and relaxed automated pilot scoring, so scorer brittleness can be separated from true target misses without replacing adjudicated review.
- A typed safety-flag taxonomy that separates return precautions, monitoring instructions, medication safety, pending/critical results, and source-stated risks while rejecting broad inferred safety themes.
- A source-grounded `handoff_atoms` layer that preserves atomic actions, targets, timing, thresholds, owners, instruction kind, safety type, and derived views before checking compatibility fields.
- Deterministic atom/view canonicalization that reports raw-model F1 separately from post-canonicalization system F1.
- A public demonstration of how to distinguish schema validity from evidence fidelity.
- Public benchmark infrastructure for ACI-Bench note-generation scoring and BioScope assertion/conformal evaluation, with raw corpora kept out of Git.
- Ongoing proxy-risk routing work for escalation and review policies.

## What is not supportable today

- Clinical accuracy.
- Clinical safety.
- Harmful-error reduction.
- Patient outcome improvement.
- Generalization to external hospitals.
- Autonomous use.
- Model superiority as a clinical conclusion.

## Next validation step

The next scientific step is factual review of the prepared evidence packets. That review should determine whether candidate-first v4's higher evidence yield reflects recovered facts, over-extraction, or a mixture of both.

The repo now includes `scripts/analyze-adjudicated-gold.js` and `eval/adjudicated_gold_template.json` for that step. Completed labels remain private/ignored; only aggregate item-level metrics should be published.

Any fresh provider-backed result should also pass the model-evidence validator, for example:

```bash
node scripts/validate-model-evidence.js --input results/model-eval.json --require-scored
```

That validation is necessary before using a new run as model evidence; it is not sufficient for clinical validation.

