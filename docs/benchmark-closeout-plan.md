# Benchmark Close-Out Plan

This is the public final approach for closing HandoffLens as a portfolio-grade research artifact.

## Critical Position

The strongest claim is not that HandoffLens is clinically safe. It is that span-level citation is an incomplete proxy for grounding in clinical extraction, and that typed, assertion-aware provenance can measure the gap.

The public repo now supports that claim as a reproducible method and includes first public benchmark-backed component results. The current benchmark evidence is still bounded: ACI-Bench is scored as note generation with deterministic baselines and source-support proxies, while BioScope is scored as a collapsed assertion cue task with same-task baselines and conformal prediction sets. Neither result is a clinical validation result.

## Build Path

1. Use profiles to move corpus-specific section headings, cue regexes, abbreviation expansions, and bounded lab-inference rules out of extraction code.
2. Use the records adapter contract to map each benchmark into `{ record_id, source_text, metadata, gold_items }`.
3. Validate benchmark intent with `eval/benchmark_manifest.example.json`.
4. Score assertion behavior on BioScope first, then i2b2 2010 when DUA access is available.
5. Score extraction on ACI-Bench first, then i2b2/n2c2 medication and relation tasks when DUA access is available.
6. Report overstatement rate only after the assertion detector has a measured error profile on the target benchmark.

## Current Benchmark Status

- ACI-Bench public JSON ingestion is implemented across all 30 public challenge files.
- ACI native note-generation scoring is implemented with ROUGE and bootstrap intervals.
- ACI deterministic generated-note baselines are implemented and run. Full-note splits favor `tail_reference_length`; section files require section-aware methods.
- ACI item-style scoring is retained only as a diagnostic because public ACI-Bench does not ship HandoffLens-native `gold_items`.
- BioScope sentence-only assertion scoring is implemented and run on public abstracts plus full papers.
- BioScope same-task baselines are implemented. The current HandoffLens assertion detector is above majority and NegEx-style baselines, but below a transparent ConText-style cue baseline on this collapsed task.
- BioScope conformal prediction sets are implemented. Label-conditional calibration improves class coverage but abstains heavily.
- The public BioScope clinical XML is redacted and does not support a valid clinical-note assertion score.

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

- A benchmark manifest alone is not a result table.
- The profile regexes are not clinical knowledge bases.
- Lab-inference rules are bounded heuristics until measured on benchmark data.
- BioScope sentence-level assertion F1 is not BioScope scope-boundary performance.
- ACI extractive baselines are not clinically adequate notes.
- DUA-bound data and non-public held-out findings must remain outside the public repo.

## Near-Term Priority

The highest-value next implementation is not another local prompt tweak. It is a stronger assertion layer and a real model-generated ACI note run against the deterministic baselines. In parallel, i2b2 and n2c2 should proceed only under the correct access terms.
