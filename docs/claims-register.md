# Claims Register

| Evidence | Allowed claim | Prohibited interpretation |
| --- | --- | --- |
| Synthetic two-case fixture | The pipeline parses, validates, and scores known fixtures | Clinical accuracy |
| Unlabeled study cohort | Completion, schema validity, route-specific latency, cost, repair burden | Precision, recall, safety, or model superiority |
| 400-case structured-output exact-provenance baseline | Schema-valid output and exact source anchoring are separable; miss taxonomy and deterministic span-ID recovery can prioritize review of normalization, non-contiguous quote, pointer-drift, weak-overlap, low-overlap, and abstain cases | Hallucination rate, clinical factuality, semantic entailment, or proof that low-overlap cases are fabricated without manual review |
| Decomposition stress diagnostic and coherence audit on lowest exact-provenance items | Alternative parsing policies can be compared on deliberately difficult failed-provenance evidence items; assertion-guarded query-aware retrieval can recover additional auditable spans with much lower context cost than full-note normalization while preserving abstention on low-overlap and assertion-conflict items | Population performance, causal proof that note length causes failure, semantic factuality, or proof that chunking solves low-overlap unsupported items |
| Model-side hard20 diagnostic | On selected dense/low-performing private cases, candidate-first v4 is more auditable than full-note request-mode variants under deterministic provenance gates | Model superiority, clinical correctness, semantic completeness, population performance, or treating exact source support from materialized candidates as independent factuality proof |
| Case-gate arithmetic and evidence-dedup diagnostics | Item-count stratification, effective item-count estimates, conservative near-duplicate removal, and auditable-or-review-routed rates can diagnose over-extraction and review-routing burden | Claiming that a case is clinically correct because it is review-routed, treating low-overlap items as clean abstentions, or claiming over-extraction is solved without human factual labels |
| Span-budget diagnostic | Lexical top-k and transparent reranker-style top-k curves can measure support/context tradeoffs over the same selected stress tasks | Claiming semantic factuality, learned retriever performance, model superiority, or proof that larger context budgets improve clinical correctness |
| Span-ID v5 cross-provider schema ablation | Stable source-span IDs can be evaluated against generated free-text quotes under matched hard20 cases, frozen providers, and repeated runs; provider-specific cap violations and case-gate effects are measurable | Claiming span-ID resolvability proves semantic grounding, claiming universal model improvement, or treating hosted-schema cap violations as clean supported evidence |
| LLM-judge review | Exploratory failure taxonomy and review prioritization hypotheses | Clinician ground truth or clinical accuracy |
| Risk-enriched clinician development cohort | Failure modes, annotation refinement, judge/routing development | Population prevalence or confirmatory comparison |
| Probability-sampled independent source-fidelity test cohort | Prespecified paired semantic-fidelity endpoints with intervals | Clinical safety, appropriateness, harmfulness, or generalization beyond the study population |
| Proxy-calibrated conformal experiment | Methods feasibility for the proxy outcome | Coverage of clinical correctness |
| BioScope collapsed sentence assertion benchmark | Adjacent-domain cue-level assertion behavior with same-task baselines and explicit scope-task caveats | Clinical-note assertion validity, standard BioScope scope-boundary performance, or clinical safety |
| ACI-Bench note-generation baselines | Public ACI ingestion, native note-generation ROUGE baselines, and lexical source-support diagnostics | Official model leaderboard performance, item-extraction F1, or clinically adequate generated notes |
| ACI-Bench Command A+ note generation plus attribution repair | Benchmark-shaped evidence that model notes beat deterministic extractive baselines under the repository scorer and that pre-specified compact source-span repair retains most ROUGE-L while reducing unsupported-sentence flags under a lexical proxy | Official ACI-Bench leaderboard performance, direct comparison to published full-note ROUGE without matching scorer/splits/preprocessing, same-row repair-method selection proof, semantic factuality proof, solved source-grounded clinical generation, or treating `1.0000` lexical support as independent proof of grounding |
| Annotator-calibrated held-out fidelity routing | Selective source-fidelity risk under stated assumptions | Clinical or autonomous safety |
| Fixed-output fidelity ablation on development labels | Select evidence-verification threshold and expose error-yield tradeoffs | Confirmatory clinical mitigation effectiveness |
| Locked evidence policy on independent source-fidelity labels | Held-out semantic-error detection and review burden | Improved patient outcomes or clinical safety |
| Adjudicated item-level gold set | Precision, recall, F1, and domain-specific false-positive/false-negative counts for explicit reviewed targets | Clinical safety, external validity, or population prevalence if the set is risk-enriched or development-selected |

All existing results generated before protocol version 1.0 are exploratory.

## Review And Governance Guardrails

- Human verification remains central. HandoffLens can prioritize source-grounded review work, but clinician verification is required for clinical use and the system must not be treated as autonomous care guidance.
- Risk-sensitive handoff review is not reducible to highest-probability text. Low-probability high-harm omissions can matter more than many correctly extracted routine facts.
- Blinded review packets must keep the model key in a separate ignored key file. Do not unblind model identity before annotations are complete.
- Risk-enriched claim samples are not probability samples and must not be used for population prevalence estimates.
- Source-fidelity analysis should report a paired difference at the `subject_id` level for outputs with at least one semantic source-fidelity error.
- Stronger source-fidelity claims require Wilson intervals and held-out adjudicated source-fidelity labels.

## Pre-Registered Minimal-Evidence Experiment Predictions

Timestamp: 2026-08-08, before running the Phase 0 guard-calibration sweep on the private hard-20 diagnostic outputs.

Decision rule: Phase 3 minimal selector work should proceed only after the budget cliff is separated from guard-threshold artifacts. If coverage-only support is flat or rising while the all-guards curve collapses, the result is a guard calibration problem, not evidence that broader context inherently destroys support.

| Prediction | Expected result | Claim boundary |
| --- | --- | --- |
| Phase 0 all-guards versus disabled-guards sweep | The all-guards curve will reproduce the budget cliff, while the all-guards-disabled curve will decline gradually or remain higher at larger budgets rather than collapsing to zero | This diagnoses guard behavior, not clinical factuality |
| Adaptive span selection versus fixed budgets | Adaptive query-aware selection will outperform every fixed top-k budget because it stops per item instead of forcing the same span count everywhere | Median selected span count describes output behavior, not a fixed setting |
| Span-ID schema | Span-ID validity should approach 1.0 when IDs are selected from a pre-enumerated index | This is by construction and does not prove semantic entailment |
| Non-contiguous quote misses | `quote_terms_present_noncontiguous` should largely disappear as a provenance-addressing failure in the span-ID arm | The unresolved question moves to whether the selected spans entail the normalized value |
| Normalization misses | `normalization_or_punctuation` should move from pointer failure into `normalized_value` correctness review | Normalized correctness still needs review or a separate scorer |
| Cross-provider ablation | The schema gain should hold across both frozen providers; if it does not, the provider interaction is itself a reportable result | Do not publish a single-provider generalization |
| Case gates | Case-level gains will be smaller than item-level gains because case gates are conjunctive and item-count sensitive | Do not let item-level support imply complete-case clinical correctness |
| Minimal selector recall cost | The selector will lose measurable recall on items requiring implicit inference or cross-section reasoning | Report recall cost explicitly rather than absorbing it into abstention |

## Phase 0 Guard Calibration Result

Timestamp: 2026-08-08, after running the guard-calibrated span-budget diagnostic on the private hard-20 aggregate outputs. Unit: failed exact-provenance evidence item. Case-level outputs, source text, raw model responses, and logprob traces remain private and uncommitted.

Primary route: `cohere-json-schema:command-a-plus-05-2026`, transparent reranker-style top-k, 271 selected failed exact-provenance items.

| Condition | Budget 1 | Budget 2 | Budget 4 | Budget 8 | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| All guards active | 164/271, 60.5% [54.6, 66.2] | 140/271, 51.7% [45.7, 57.6] | 0/271, 0.0% [0.0, 1.4] | 0/271, 0.0% [0.0, 1.4] | Reproduces the cliff |
| Label-risk disabled, assertion active | 164/271, 60.5% [54.6, 66.2] | 232/271, 85.6% [80.9, 89.3] | 238/271, 87.8% [83.4, 91.2] | 227/271, 83.8% [78.9, 87.7] | The cliff is mostly label-risk threshold behavior |
| All guards disabled | 165/271, 60.9% [55.0, 66.5] | 237/271, 87.5% [83.0, 90.9] | 262/271, 96.7% [93.8, 98.2] | 266/271, 98.2% [95.8, 99.2] | Coverage does not collapse with larger budgets |
| Budget-normalized label risk, assertion active | 164/271, 60.5% [54.6, 66.2] | 179/271, 66.1% [60.2, 71.4] | 160/271, 59.0% [53.1, 64.7] | 198/271, 73.1% [67.5, 78.0] | Reduces the artifact but does not replace adaptive stopping |

Decision: the fixed-budget cliff should not be cited as evidence that broader context inherently destroys provenance support. It is primarily a strict label-risk guard artifact. The next design should use minimal sufficient evidence selection with adaptive stopping, calibrated assertion/label-risk guards, and an explicit recall-cost report. The adaptive query-aware policy on the same primary route supported 214/271 items, 79.0%, with median selected span count 2; that number is item-level auditability under lexical/span support, not semantic entailment or clinical correctness.

## Phase 3 Minimal Selector Recall Cost

Timestamp: 2026-08-08. Unit: failed exact-provenance evidence item. This compares deterministic post-hoc evidence selection policies over existing private hard-slice model outputs; it is not a fresh model-output comparison.

| Metric | Result | Interpretation |
| --- | ---: | --- |
| Old adaptive query-aware support | 214/271, 79.0% [73.7, 83.4] | Prior item-level lexical/span support baseline |
| Minimal selector support | 249/271, 91.9% [88.0, 94.6] | Smaller deterministic span sets can recover more auditability on this slice |
| Old-supported retained by minimal selector | 206/214, 96.3% [92.8, 98.1] | Most prior supported items remain supported |
| Recall cost among old-supported items | 8/214, 3.7% [1.9, 7.2] | Lost items are the explicit tradeoff |

Recall-loss categories: assertion conflict 3, budget-normalized label risk 3, old policy exceeded the 3-span cap 2. Recall-loss features: multi-span composition 8, label-risk-sensitive 6, assertion-sensitive 3, normalization-sensitive 2, cross-section reasoning 1. Mean supported context fell from 16.164 words under the old query-aware policy to 10.795 words under the minimal selector. This supports the selector as an auditability design, not a semantic grounding solution.

## Phase 4 Cross-Provider Span-ID v5 Ablation Result

Timestamp: 2026-08-08. Unit: provider run and extracted evidence item. The 20 private hard cases were run across Cohere Command A+ and Anthropic Claude Haiku 4.5, with three repeats per model/arm cell. Raw case-level model outputs, source text, and raw provider telemetry remain private and uncommitted.

| Model and arm | Successful runs | Items | Item support | Case gate | Span IDs resolve | Full v5 contract | Interpretation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Haiku quote-v2 | 60/60 | 1,825 | 1,709/1,825, 93.6% [92.4, 94.7] | 20/60, 33.3% [22.7, 45.9] | N/A | N/A | Strong generated-quote baseline on this slice |
| Haiku quote-v2 + minimal selector | 60/60 | 1,825 | 1,719/1,825, 94.2% [93.0, 95.2] | 17/60, 28.3% [18.5, 40.8] | N/A | N/A | Slight item gain, worse complete-case gate |
| Haiku span-ID-v5 | 60/60 | 2,168 | 1,453/2,168, 67.0% [65.0, 69.0] | 2/60, 3.3% [0.9, 11.4] | 2,168/2,168, 100.0% [99.8, 100.0] | 1,144/2,168, 52.8% [50.7, 54.9] | Over-selected spans after provider schema constraints were stripped |
| Haiku span-ID-v5 + minimal selector | 60/60 | 2,168 | 1,934/2,168, 89.2% [87.8, 90.4] | 9/60, 15.0% [8.1, 26.1] | 2,168/2,168, 100.0% [99.8, 100.0] | 1,144/2,168, 52.8% [50.7, 54.9] | Selector recovers much of the item support, but not the contract |
| Cohere quote-v2 | 60/60 | 1,192 | 769/1,192, 64.5% [61.8, 67.2] | 5/60, 8.3% [3.6, 18.1] | N/A | N/A | Generated quotes remain brittle under exact support |
| Cohere quote-v2 + minimal selector | 60/60 | 1,192 | 1,131/1,192, 94.9% [93.5, 96.0] | 24/60, 40.0% [28.6, 52.6] | N/A | N/A | Strongest Cohere item and case-gate result, but selector support is still lexical |
| Cohere span-ID-v5 | 59/60 | 1,276 | 1,127/1,276, 88.3% [86.4, 90.0] | 18/59, 30.5% [20.3, 43.2] | 1,276/1,276, 100.0% [99.7, 100.0] | 1,102/1,276, 86.4% [84.4, 88.1] | Span IDs improve pointer integrity and support versus quote-v2 |
| Cohere span-ID-v5 + minimal selector | 59/60 | 1,276 | 1,185/1,276, 92.9% [91.3, 94.2] | 21/59, 35.6% [24.6, 48.3] | 1,276/1,276, 100.0% [99.7, 100.0] | 1,102/1,276, 86.4% [84.4, 88.1] | Better than raw span-ID support, but below quote-v2 minimal on this slice |

Decision: span IDs are useful as a provenance-addressing interface because unresolved pointers disappear when provider-side enums are honored. They do not solve semantic support. The full v5 contract is the honest metric because hosted structured-output compatibility required removing some local schema constraints, including the max-3 evidence-span cap; Haiku's 703 too-many-span-ID violations are a design failure, not a harmless formatting issue. The next engineering step is a cap-violation retry or repair loop plus learned reranking or entailment checks, not another claim that pointer validity equals factuality.

## Phase 5 Length Versus Density Result

Timestamp: 2026-08-08. Unit: completed source record and evidence item. Thresholds: short note <1500 words; high density >=16 evidence items per 1k words.

| Cell | Records | Evidence items | Exact item rate | Span-supported item rate | Abstain item rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Short high-density | 13 | 539 | 431/539, 80.0% [76.4, 83.1] | 520/539, 96.5% [94.6, 97.7] | 19/539, 3.5% [2.3, 5.4] |
| Long high-density | 9 | 629 | 406/629, 64.5% [60.7, 68.2] | 539/629, 85.7% [82.7, 88.2] | 90/629, 14.3% [11.8, 17.3] |
| Short low-density | 0 | 0 | N/A | N/A | N/A |
| Long low-density | 0 | 0 | N/A | N/A | N/A |

Decision: this private hard slice cannot disentangle length from density because the off-diagonal cells are empty. The allowed claim is association with harder provenance on longer/dense records. The prohibited claim is that density, rather than length, is causally responsible.

## Evidence Needed For Stronger Claims

- Entailment-backed source support: lexical overlap should be replaced or supplemented with a factuality/entailment scorer, such as MiniCheck, AlignScore, or a clinical NLI comparator, followed by manual review of disagreements.
- Official ACI scorer reproduction: the repository scorer needs an official-scorer sanity check, including transcript-copy and at least one published-system or baseline reproduction, before comparing to published full-note ROUGE.
- In-domain clinical assertion validation: the target-aware item-quote behavior must be measured on clinical-note text, not only BioScope biomedical literature. Suitable paths are DUA-controlled i2b2/n2c2 data or private adjudicated clinical gold.
- Schema-enforcement and reranker follow-up: the span-ID-only ablation has run. The remaining design work is to test a retry/repair loop for max-3 cap violations and compare the lexical span matcher against an embedding or reranker-backed matcher under the same case-gate and review-routing metrics.
- Human source-fidelity labels: automated gates and LLM judges can prioritize review, but stronger source-fidelity claims require independent human labels with intervals.
