# Model Card: HandoffLens

## Summary

HandoffLens is a research and engineering system for source-grounded extraction from discharge-summary-style text. Its purpose is to make LLM-generated evidence auditable: every accepted item should be traceable to a source quote, and unsupported output should be blocked, abstained, or routed for review.

This is not a medical device and is not intended for clinical use.

This repository is my independent work. It does not represent the views, strategies, or endorsement of Cohere or any other model provider.

## Intended audience

This model card is written for engineers, data scientists, technical professionals, and reviewers evaluating the reliability architecture. It describes what the system demonstrates, what evidence exists, and where the claims stop.

## System components

The public browser demo is a deterministic synthetic-text baseline. It requires no API key and sends no data to a server.

The research pipeline is candidate-first:

1. Normalize note formatting while retaining source traceability.
2. Detect candidate evidence spans deterministically.
3. Assign stable candidate identifiers.
4. Use an instruction model to classify ambiguous candidates.
5. Materialize final labels and summaries extractively from accepted source evidence.
6. Abstain when evidence is insufficient or validation fails.

The key design choice is separation of responsibility: deterministic code owns provenance; the model owns only bounded classification.

## Evaluation evidence

The project has several public engineering findings:

- In a 400-case structured-output baseline, most outputs passed JSON schema validation, while only a small minority passed a strict exact-source provenance check. Follow-up miss taxonomy and deterministic span-ID recovery indicate that many exact-match failures are quote-format, non-contiguous citation, or pointer-drift artifacts rather than proven fabrication. Item-level support improves under span recovery, but many items still abstain and semantic entailment is not established. The supported claim is narrower: schema validity is not evidence fidelity, and structure-only gates give little visibility into source anchoring.
- A 600-item decomposition stress diagnostic selected the lowest exact-provenance evidence items from three held-out Cohere cells and compared five parsing policies. Assertion-guarded clause-aware query retrieval recovered 395/600 auditable supports, compared with 39/600 for normalized full-note matching and 0/600 for exact full-note matching, while using far less context on supported items. A coherence audit splits those 395 supports into 238 auto-accepted items and 157 review-required items, with 0 high-risk supported items and 205 abstentions. Target-aware assertion-cue scope checks reduce broad cue over-blocking; the later strict low-overlap rescue adds only 3 recoveries, all review-required. A full-pool validation over 13,038 failed exact-provenance items preserved 11,001 query-aware supports while converting 332 diffuse label-only unions into abstentions, leaving 0 high-risk supported items. These are failure-analysis diagnostics, not population estimates or proof that chunking solves semantic fidelity.
- A 20-case model-side hard-slice diagnostic reran Command A+ on dense/low-performing private cases across four full-note request modes plus candidate-first v4. Full-note JSON schema completed 16/20 cases but only 2/16 completed cases passed deterministic provenance gates; plain JSON completed 0/20, strict tools 4/20, and flat tools 6/20. Candidate-first v4 completed and passed deterministic provenance gates on 20/20 cases, with 716 exact source-backed evidence items. The exact support is by construction because candidate-first materializes source candidates, so this is evidence for auditability and failure-mode control, not proof of semantic completeness or clinical correctness.
- A cross-provider span-ID v5 ablation reran the 20 private hard cases across Cohere Command A+ and Anthropic Claude Haiku 4.5, with three repeats per model/arm cell. Cohere improved from 769/1192 supported quote-v2 items, 64.5%, to 1127/1276 supported span-ID-v5 items, 88.3%; its minimal selector variants reached 94.9% for quote-v2 and 92.9% for span-ID-v5. Haiku did not show the same gain: quote-v2 support was 1709/1825, 93.6%, while span-ID-v5 fell to 1453/2168, 67.0%, with 703 too-many-span-ID violations after hosted schemas stripped local max-3 constraints. Because item counts differed by arm, raw case gates are not like-for-like. A matched-count paired check preserved the direction: Haiku quote-v2 beat span-ID-v5 at matched volume, while Cohere span-ID-v5 beat quote-v2. A deterministic cap-repair pass then raised Cohere span-ID-v5 repaired support to 1224/1276, 95.9%, and repaired case gate to 34/59, 57.6%, with local contract validity at 1276/1276. Successful span-ID runs had 100% resolvable IDs by construction, so this is pointer-integrity evidence, not semantic-factuality evidence.
- The provenance miss taxonomy now reports case-gate arithmetic explicitly: evidence-item counts, effective item count implied by item/case gate rates, item-count-stratified gate outcomes, deterministic source candidate IDs, conservative near-duplicate evidence removal, and an auditable-or-review-routed metric that keeps low-overlap possible-fabrication items unresolved.
- The decomposition stress runner now reports span-budget curves over 1, 2, 4, and 8 spans for lexical top-k matching and a transparent reranker-style matcher. This measures context-budget tradeoffs before adding learned retrieval.
- Evidence-pointer v2 provided a conservative source-grounded comparator, but it was less robust than candidate-first v4 in the final development rerun.
- Candidate-first v4 passed deterministic provenance gates on 19 of 20 development cases in the June 23 rerun, with one abstention. Extractive rematerialization reduced unsupported-summary numeric leakage in the source-fidelity proxy audit.
- The current atom/view bridge adds source-grounded `handoff_atoms`, deterministic compatibility-field canonicalization, raw-model versus system-score reporting, and typed safety-flag evaluation.
- Public ACI-Bench diagnostics now include deterministic note baselines, Command A+ generated-note scoring, lexical source-support scoring, and compact attribution repair. Command A+ improves ROUGE over extractive baselines under the repository scorer, while compact repair retains most ROUGE-L and reduces unsupported-sentence flags under a lexical proxy. The ACI result is not an official leaderboard submission, and the compact repair policy is pre-specified rather than selected as a same-row ablation winner. Its high lexical support is expected from source-span repair and is not semantic factuality proof.
- Public BioScope diagnostics now include same-task transparent baselines and a hybrid assertion detector on the collapsed sentence-level cue task. The hybrid detector incorporates the transparent cue comparator for sentence-level inputs, while preserving HandoffLens target-aware checks for item quotes. This is adjacent-domain assertion evidence, not clinical-note validation or official BioScope scope-boundary performance.

These are engineering results. They are not clinical accuracy estimates.

## Current limitations

- Human factual review is prepared but not complete.
- Clinical review is not complete.
- The higher item yield in candidate-first v4 may represent recovered evidence, over-extraction, or both.
- The remaining proxy-audit flags require factual review, especially possible negation conflicts.
- No temporal validation is available because the records do not contain usable real dates/times.
- No external validation cohort is available.
- LLM-as-judge outputs are development proxies, not ground truth.
- Two-case synthetic fixture scores are regression signals, not stable benchmarks or clinical performance estimates.
- Lexical source-support metrics do not prove semantic factuality, entailment, temporal correctness, or clinical completeness.
- ACI-Bench and BioScope public diagnostics are benchmark-shaped evidence with explicit task caveats, not clinical validation. The ACI ROUGE values should not be compared to published full-note scores without matching scorer, preprocessing, and split protocol.
- The decomposition stress diagnostic is selected from difficult failed-provenance items and should not be read as a population-level performance estimate or causal proof about note length.
- The auditable-or-review-routed metric is for triage accounting, not clinical correctness; it separates weak-overlap review routing from ordinary failure without relaxing strict provenance gates.
- The span-budget curve is a deterministic proxy diagnostic. The transparent reranker-style matcher is not an embedding model and should not be reported as a neural reranker result.
- Span-ID resolvability is expected when provider-side enums are honored. The harder constraints are cap compliance, semantic support, assertion scope, and whether selected spans entail the normalized item.
- Hosted structured-output routes did not enforce every local JSON-schema constraint, including the max-3 span cap. Deterministic cap repair improves local contract compliance, but it should be reported separately from raw model behavior.
- Span-ID raw case-gate comparisons are volume-confounded because arms emit different numbers of items. Matched-count comparisons reduce but do not eliminate target-selection confounding.

## Next validation priorities

Update (2026-08): the live-retry test and an LLM-judge entailment score have since been run (see the "Recent experiments" section of the README, `docs/experiments/retry-recovery-results.md`, and `docs/experiments/support-score-bakeoff-results.md`). What remains below is updated accordingly.

- Replace or augment lexical source support with a **dedicated** entailment/faithfulness scorer (MiniCheck, AlignScore, or a clinical NLI comparator). The bake-off used an LLM-as-judge entailment score, which is a model estimate, not a calibrated faithfulness metric.
- Measure the target-aware item-quote assertion checks on in-domain clinical text, either through DUA-controlled i2b2/n2c2 access or a private adjudicated clinical gold set.
- **Done:** a live retry prompt for span-ID contract failures was tested (recovers ~79% of Command A+ over-emissions, 100% Haiku; residual needs deterministic cap repair). Still pending: compare an embedding/reranker-backed span matcher against the lexical matcher under matched budgets.
- Human-review a small slice of entailment/scorer disagreements so automated factuality scores do not become hidden ground truth.

## Allowed claims

The current evidence supports claims about:

- schema validity versus source fidelity;
- deterministic provenance checking;
- abstention behavior;
- extractive rematerialization;
- stability under small perturbations;
- cost and latency telemetry;
- review-readiness and routing design;
- item-count and case-gate tradeoff diagnostics;
- span-budget and context-cost diagnostics;
- public benchmark adapter/scorer reproducibility;
- measured trade-offs between model fluency, extractive source support, and attribution repair.

## Claims not supported

The current evidence does not support claims about:

- clinical safety;
- clinical correctness;
- harmful-error reduction;
- appropriateness of care;
- patient outcomes;
- autonomous deployment;
- generalization to other institutions or patient populations.

## Privacy and data boundary

The public repository contains code, schemas, prompts, synthetic fixtures, aggregate results, and documentation. It does not contain source records, private cohorts, case-level private outputs, reviewer packets, API keys, or completed human annotations.

Any real deployment would require institutional governance, data-access controls, audit logging, external validation, qualified clinical review, and direct source verification.
