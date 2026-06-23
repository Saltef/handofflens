# Project status

Last updated: 2026-06-23

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
- A public demonstration of how to distinguish schema validity from evidence fidelity.
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

