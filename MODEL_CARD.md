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
- A 300-item decomposition stress diagnostic selected the lowest exact-provenance evidence items from three held-out Cohere cells and compared five parsing policies. Assertion-guarded query-aware multi-span retrieval recovered 158/300 auditable supports, compared with 35/300 for normalized full-note matching and 0/300 for exact full-note matching, while using far less context on supported items. A coherence audit splits those 158 supports into 92 auto-accepted items and 66 review-required items, with 0 high-risk supported items and 142 abstentions. This is failure-analysis evidence, not a population estimate or proof that chunking solves semantic fidelity.
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

## Next validation priorities

- Replace or augment lexical source support with entailment-backed faithfulness checks, such as MiniCheck, AlignScore, or a clinical NLI comparator when an appropriate local/runtime path is available.
- Measure the target-aware item-quote assertion checks on in-domain clinical text, either through DUA-controlled i2b2/n2c2 access or a private adjudicated clinical gold set.
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
