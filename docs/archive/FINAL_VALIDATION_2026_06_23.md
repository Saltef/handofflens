# Final validation snapshot - 2026-06-23

This snapshot records the final engineering validation pass run on June 23, 2026. It is aggregate-only and intentionally excludes source notes, case-level outputs, reviewer packets, API keys, and private labels.

## Bottom line

Candidate-first v4 is the strongest current pipeline, but the result is still an engineering result, not a clinical validation. The live rerun passed deterministic provenance gates for 19 of 20 development cases. A deterministic extractive rematerialization step materially improved source-fidelity proxy checks by removing unsupported numeric details from model-written summaries.

The remaining unresolved issues are factual-review targets, especially possible negation conflicts and over-extraction risk.

## Final test matrix

| Test | Result | Interpretation |
| --- | ---: | --- |
| Full public repo checks | Passed | Syntax, schema/protocol checks, unit tests, and share scan passed. |
| Clean export reproducibility | Passed previously and export tooling retained | Clean folder can be generated from Git-tracked public files only. |
| Candidate-first v4 final20 live rerun | 19/20 gate pass; 1 abstain | Strong engineering signal; no clinical correctness claim. |
| V4 stability, 5 cases, two selection repeats | 5/5 pass; median Jaccard 1.0; minimum Jaccard 0.5 | Mostly stable, but model-selected candidates are not perfectly repeatable. |
| Whitespace perturbation, 5 cases | 5/5 pass | Robust to mild whitespace normalization. |
| Rewrap perturbation, 5 cases | 5/5 pass | Robust to more aggressive line wrapping in this small test. |
| Evidence-pointer v2 final20 rerun | 17/20 technical success; 10/17 provenance-gate pass | Useful comparator, but less reliable than v4. |
| Original v4 summary source-fidelity audit | 5/20 records passed proxy audit | Model-written summaries leaked unsupported numeric details. |
| Extractive v4 source-fidelity audit | 17/20 records passed proxy audit | Deterministic summaries fixed numeric leakage; 4 possible negation flags remain. |
| 50-case source-fidelity packet dry run | 46 complete cases; 92 model outputs | Ready for non-clinician factual review. |
| v2/v4 factual comparison packet | 30 items: 10 shared, 10 v2-only, 10 v4-only | Ready for targeted factual review. |

## Key aggregate outputs

| Artifact | Aggregate result |
| --- | --- |
| `results/candidate-first-v4-final20-20260623/combined.json` | 20 attempted, 19 final-gate passes, 1 abstention, 39 Cohere calls, no stage failures. |
| `results/candidate-first-v4-final20-20260623-extractive/combined.json` | 20 records, 524 evidence items after deterministic rematerialization. |
| `results/candidate-first-v4-final20-20260623-extractive/source-fidelity-audit.json` | 17/20 records passed proxy audit; remaining issue type: possible negation conflict. |
| `results/candidate-first-v4-stability5-20260623/combined.json` | 5/5 pass, median selection Jaccard 1.0, minimum 0.5. |
| `results/candidate-first-v4-whitespace5-20260623/combined.json` | 5/5 pass. |
| `results/candidate-first-v4-rewrap5-20260623/combined.json` | 5/5 pass. |
| `results/evidence-pointer-v2-final20-20260623/combined.json` | 17 technical successes, 3 failures, 10 provenance-gate passes. |
| `results/source-fidelity-pilot50-master-packet.json` | 46 complete blinded source-fidelity review cases, 92 outputs. |
| `results/v2-v4-factual-review-30-20260623/review-packet.json` | 30-item factual comparison packet. |

These paths are local validation outputs and are not included in the clean public export.

## Cost and latency telemetry

| Run | Calls | Median latency | p95 latency | Input tokens | Output tokens | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Candidate-first v4 final20 | 39 | 2,331 ms | 4,104 ms | 97,501 | 29,416 | 19,932 |
| Candidate-first v4 stability5 | 15 | 2,499 ms | 3,613 ms | 38,151 | 11,052 | 7,679 |
| Evidence-pointer v2 final20 | 17 | 3,193 ms | 5,558 ms | 75,017 | 17,394 | 8,704 |

## What changed scientifically

The important scientific correction is that generated summaries are no longer treated as trustworthy just because their supporting extraction items pass schema/provenance checks. The original final20 v4 output passed 19/20 gates, but the summary audit found unsupported numeric details in 14 records. After deterministic extractive rematerialization, unsupported-summary numeric flags disappeared and only four possible negation-conflict flags remained.

That is the right failure mode to surface: the extraction architecture can be promising while the final narrative layer remains unsafe unless it is extractive or separately verified.

## Remaining human-review targets

1. Review the four possible negation-conflict flags in the extractive v4 audit.
2. Review whether v4's higher item yield reflects recovered omissions or over-extraction.
3. Review quote completeness for the 30-item v2/v4 packet.
4. Review the 46-case / 92-output source-fidelity packet.
5. Do not make clinical safety, harmfulness, or appropriateness claims without clinician review.

## Defensible claim after this pass

> Candidate-first v4, combined with deterministic extractive rematerialization and source-fidelity audits, is a stronger engineering architecture than schema-only generation for this dataset. It makes unsupported summaries, abstentions, provenance failures, instability, and review needs visible. It remains unvalidated for clinical correctness, clinical safety, and generalization.



