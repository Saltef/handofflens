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
5. Score note generation on ACI-Bench with deterministic baselines, provider-generated notes, and source-support diagnostics.
6. Treat attribution repair as a measured design intervention: compare raw model notes, compact source-span repair, and deterministic extractive baselines.
7. Move from lexical source support to semantic source support before claiming clinical grounding: evidence atoms should carry assertion, temporality, and entailment checks.

## Current Benchmark Status

- ACI-Bench public JSON ingestion is implemented across all 30 public challenge files.
- ACI native note-generation scoring is implemented with ROUGE and bootstrap intervals.
- ACI deterministic generated-note baselines are implemented and run. Full-note splits favor `tail_reference_length`; section files require section-aware methods.
- ACI Command A+ generated-note evaluation is implemented and run over the five canonical full-note public splits. The model beats deterministic compressed baselines on ROUGE, but lexical source support remains weak.
- ACI attribution repair is implemented and run. The selected `compact_extractive` method preserves full scored-case coverage, retains 91.2% of raw Command A+ ROUGE-L, reduces unsupported-sentence case rate by 75.4 percentage points, and remains above deterministic extractive baselines on ROUGE-L. Its lexical source-token support is `1.0000` by construction and should be treated as a gate-style diagnostic, not proof of semantic factuality.
- ACI item-style scoring is retained only as a diagnostic because public ACI-Bench does not ship HandoffLens-native `gold_items`.
- BioScope sentence-only assertion scoring is implemented and run on public abstracts plus full papers.
- BioScope same-task baselines are implemented. The assertion detector is now hybrid: it incorporates the transparent ConText-style cue comparator on the collapsed sentence task while preserving target-aware checks for extracted clinical item quotes. The target-aware item-quote behavior remains unmeasured on an in-domain clinical assertion benchmark.
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
- Command A+ ACI results are benchmark-shaped diagnostics, not official leaderboard submissions.
- Attribution repair is lexical evidence control, not proof of semantic factuality. Source-token support of `1.0000` after source-span repair is expected by construction; ROUGE retention, unsupported-sentence reduction, token growth, and entailment checks are the meaningful next evidence.
- DUA-bound data and non-public held-out findings must remain outside the public repo.

## Near-Term Priority

The next real improvement is semantic attribution: keep the two-stage design, but replace pure lexical compact spans with evidence atoms that include assertion status, temporal status, numeric preservation, and entailment/contradiction checks. That is the most credible way to improve source support without collapsing into verbose extractive copying. In parallel, i2b2 and n2c2 should proceed only under the correct access terms.
