# Evidence Pointer v2

Public-facing note: this report describes a conservative source-pointer architecture used as a comparator for candidate-first v4. It is included to show the design path, not as the final recommended pipeline.

## Problem

The held-out engineering candidate produced technically valid JSON in 350/400 cases, but only 40/400 passed a deterministic provenance gate. In 310 cases, at least one generated `source_quote` was not a contiguous lexical source span. Punctuation and Unicode normalization changed only five case outcomes, indicating genuine paraphrasing rather than cosmetic formatting.

## Design

The model no longer generates quotation text. The source is indexed into immutable non-empty lines (`L0001`, `L0002`, ...). Evidence items return `source_start_id` and `source_end_id`. Application code validates the ordered endpoints and materializes the complete contiguous `source_quote` directly from the original source.

The downstream canonical extraction remains unchanged: consumers still receive `label`, `rationale`, and an exact `source_quote`. The pointer representation is an internal provider contract.

## Safety properties

- Unknown or reversed span identifiers are blocking failures.
- Materialized evidence is guaranteed to originate from the supplied source text.
- This proves provenance, not semantic entailment. A source span can still be selected for an unsupported label or rationale.
- Narrative-summary support remains outside deterministic validation.

## Evaluation sequence

1. Synthetic pointer/materialization contract tests.
2. Small pilot using only the 100 development cases.
3. Compare pointer validity, canonical gate pass rate, latency, tokens, and automated component burden against the frozen baseline.
4. Do not reopen or tune against the held-out 400-case result.

## Development pilot (20 cases)

The first list-of-line-IDs prototype passed 10/20 technically but failed 10/20 because the model selected noncontiguous IDs inside individual items; three nominal passes were also evidence-free. That representation was rejected.

The revised start/end-span contract produced:

- technical/adapter success: 19/20 (95%);
- full deterministic gate pass: 14/20 (70%; Wilson 95% CI 48.1%–85.5%);
- failures: one reversed span and five vacuous/short outputs;
- original generated-quote baseline on the same cases: 2/20 gate passes (10%; Wilson 95% CI 2.8%–30.1%);
- paired outcomes: 12 span-only passes, 0 baseline-only passes, 2 both passed, and 6 neither passed.

This is a repeatedly inspected development sample, so the paired improvement is descriptive and must not be presented as an unbiased confirmatory effect. It establishes architectural promise, not semantic correctness. Source-span selection, label entailment, completeness, and narrative-summary support still require independent evaluation.
