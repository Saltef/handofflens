# Benchmark Close-Out Plan

This is the public final approach for closing HandoffLens as a portfolio-grade research artifact.

## Critical Position

The strongest claim is not that HandoffLens is clinically safe. It is that span-level citation is an incomplete proxy for grounding in clinical extraction, and that typed, assertion-aware provenance can measure the gap.

The public repo now supports that claim as a reproducible method. It does not yet contain external benchmark scores. That is intentional: benchmark numbers should appear only after dataset access, adapter validation, scoring, and evidence certification.

## Build Path

1. Use profiles to move corpus-specific section headings, cue regexes, abbreviation expansions, and bounded lab-inference rules out of extraction code.
2. Use the records adapter contract to map each benchmark into `{ record_id, source_text, metadata, gold_items }`.
3. Validate benchmark intent with `eval/benchmark_manifest.example.json`.
4. Score assertion behavior on BioScope first, then i2b2 2010 when DUA access is available.
5. Score extraction on ACI-Bench first, then i2b2/n2c2 medication and relation tasks when DUA access is available.
6. Report overstatement rate only after the assertion detector has a measured error profile on the target benchmark.

## Definition of Done

A benchmark result is publishable only when it includes:

- dataset version and access status;
- profile id;
- adapter version;
- model and prompt version;
- exact and relaxed matching policy where applicable;
- precision, recall, F1, and confidence intervals;
- ablations for exact-span, typed provenance, and typed-plus-entailment gates;
- a claims-register update that names what the result does not establish.

## Explicit Non-Claims

- The current public benchmark manifest is not a result table.
- The profile regexes are not clinical knowledge bases.
- Lab-inference rules are bounded heuristics until measured on benchmark data.
- DUA-bound data and non-public held-out findings must remain outside the public repo.

## Near-Term Priority

The highest-value next implementation is not another local prompt tweak. It is the first public adapter and scoring run. BioScope and ACI-Bench are the practical starting points; i2b2 and n2c2 should proceed only under the correct access terms.
