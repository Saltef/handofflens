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

The project has three main public engineering findings:

- In a 400-case structured-output baseline, most outputs passed JSON schema validation, but only about 10% passed exact-source provenance. This demonstrates that schema validity is not evidence fidelity.
- Evidence-pointer v2 provided a conservative source-grounded comparator, but it was less robust than candidate-first v4 in the final development rerun.
- Candidate-first v4 passed deterministic provenance gates on 19 of 20 development cases in the June 23 rerun, with one abstention. Extractive rematerialization reduced unsupported-summary numeric leakage in the source-fidelity proxy audit.
- The current atom/view bridge adds source-grounded `handoff_atoms`, deterministic compatibility-field canonicalization, raw-model versus system-score reporting, and typed safety-flag evaluation.
- Public ACI-Bench diagnostics now include deterministic note baselines, Command A+ generated-note scoring, lexical source-support scoring, and compact attribution repair. Command A+ improves ROUGE over extractive baselines, while compact repair improves lexical source support with measured ROUGE and length trade-offs.
- Public BioScope diagnostics now include same-task transparent baselines and a hybrid assertion detector on the collapsed sentence-level cue task. This is adjacent-domain assertion evidence, not clinical-note validation or official BioScope scope-boundary performance.

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
- ACI-Bench and BioScope public diagnostics are benchmark-shaped evidence with explicit task caveats, not clinical validation.

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
