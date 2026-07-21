# Documentation map

Start here if you are reviewing the project quickly:

## Core

- [Scientific Write-up](SCIENTIFIC_WRITEUP.md) - full problem framing, architecture, and findings.
- [Final Validation Snapshot](FINAL_VALIDATION_2026_06_23.md) - fresh rerun, stability checks, source-fidelity audit, and review-packet status.
- [Project Status](PROJECT_STATUS.md) - what has actually run and what the results support.
- [Claims Register](claims-register.md) - allowed and prohibited interpretations.
- [Model Card](../MODEL_CARD.md) - intended use, non-use, and limitations.
- [Conformal and Selective-Routing Work](conformal-routing-ongoing.md) - ongoing proxy-risk routing appendix and how to interpret it.
- [Benchmark Close-Out Plan](benchmark-closeout-plan.md) - final public approach for external benchmark completion.
- [Records Adapter Contract](records-adapter-contract.md) - stable input schema for dataset adapters.
- [Benchmark Adapter and Scoring](benchmark-adapter-scoring.md) - ACI-style adapter and item-level benchmark scorer.
- [Public Benchmark Run Results](public-benchmark-results-2026-07-21.md) - first ACI/BioScope public benchmark execution.

## Reproducibility and sharing

- [Reproducibility](REPRODUCIBILITY.md) - commands, private-input boundaries, and artifact handling.
- [Data Exposure Attestation](data-exposure-attestation.md) - what is excluded from the public repository.
- [Final Tests](FINAL_TESTS.md) - final engineering tests and what still requires review.
- [Security Checklist](security-checklist.md) - secret and private-data handling.

## Experiment history and negative results

- [Experiment History](EXPERIMENT_HISTORY.md) - chronological decisions, including rejected approaches.
- [Candidate-first v4 Final Report](candidate-first-v4-final-report.md) - current strongest pipeline.
- [Evidence Pointer v2](evidence-pointer-v2.md) - conservative comparator.
- [Pipeline v3 Final Report](pipeline-v3-final-report.md) - rejected intermediate pipeline.
- [Pending Work](PENDING_WORK.md) - unresolved work and claims blocked by it.

## Exploratory appendices

These documents are retained as an audit trail, not as the headline claim. In particular, conformal/selective-risk analyses use proxy labels and should be read as exploratory routing work, not clinical validation. The public-facing anchor for that work is [Conformal and Selective-Routing Work](conformal-routing-ongoing.md).

- `conformal-*`
- `overlapping-group-conformal.md`
- `group-specialist-pretriage.md`
- `hybrid-safety-layer-experiment.md`
- model- and provider-specific stress-test reports
- prompt ablations and failure-pattern analyses

When a historical or exploratory document conflicts with the README, final validation snapshot, project status, or claims register, the current canonical document governs.

