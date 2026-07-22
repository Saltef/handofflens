# Benchmark Adapter and Scoring

HandoffLens now has a public benchmark-facing path without shipping benchmark data.

## ACI-Bench Adapter

`scripts/adapt-aci-bench.js` accepts a local CSV, TSV, JSON, or JSONL file with conversation-like rows and emits the HandoffLens records contract:

```bash
npm run benchmark:adapt:aci -- --input path/to/aci-bench-file.json --split dev --out eval/aci_bench_records.json
```

The adapter looks for common fields such as `src`, `dialogue`, `conversation`, or `transcript` for `source_text`, and `tgt`, `note`, `reference_note`, or `summary` for `reference_text`.

Important limitation: ACI-Bench reference notes are not item-level extraction gold by themselves. The adapter passes through `gold_items` when present, but it does not invent item labels from reference notes. Any extraction F1 table must document how item-level gold was produced.

## ACI Note-Generation Scorer

`scripts/score-aci-note-generation.js` scores a text prediction field against the ACI reference note:

```bash
npm run benchmark:score:aci-note -- --records eval/aci_bench_records.json --prediction-field generated_note --out results/aci-note-score.json
```

It reports per-case and aggregate ROUGE-1, ROUGE-2, ROUGE-L precision/recall/F1, mean prediction/reference token counts, mean compression ratio, and case-bootstrap F1 intervals. The requested `--prediction-field` is strict: rows missing that field are skipped rather than silently falling back to the transcript. The runner accepts either `--records` or `--input`.

Two usage modes should remain separate:

- `--prediction-field src` is a transcript/reference overlap baseline and ingestion diagnostic.
- `--prediction-field generated_note` or another model-output field is the benchmark-shaped path for actual note-generation evaluation.

The ROUGE scorer does not judge clinical factuality, hallucination, or source support. Those need separate groundedness and review checks.

## ACI Extractive Baselines and Source Support

The public repo includes deterministic ACI note baselines:

```bash
npm run benchmark:generate:aci-note -- --records eval/aci_bench_records.json --method tail_reference_length --out results/aci-tail-records.json
npm run benchmark:score:aci-factuality -- --records results/aci-tail-records.json --prediction-field generated_note --out results/aci-tail-source-support.json
npm run benchmark:aci-note:baselines -- --records eval/aci_bench_records.json --split valid --out results/aci-note-baseline-comparison.json
```

The comparison runner evaluates:

- `source_full`: full transcript diagnostic only;
- `lead_reference_length`: first source tokens up to the reference-note length;
- `tail_reference_length`: final source tokens up to the reference-note length;
- `cue_sentence_extractive`: source sentences with medication, follow-up, result, assessment, and procedure cues.

It reports ROUGE plus lexical source-support proxies: source-token support, source-bigram support, novel-token rate, and extractive-sentence rate. These are groundedness diagnostics, not clinical factuality metrics.

Current design implication: full-note ACI splits favor `tail_reference_length`, but section files are position-dependent. A model-based ACI result should beat the compressed deterministic baseline for the same split while maintaining high source support.

## Item-Level Scorer

`scripts/score-benchmark-records.js` scores predicted items against `gold_items`:

```bash
npm run benchmark:score -- --records eval/aci_bench_records.json --predictions results/predictions.json --out results/benchmark-score.json
```

The scorer reports:

- exact matching: exact span when both sides have spans, otherwise exact normalized label;
- relaxed matching: domain-compatible token Dice matching;
- maximum-weight one-to-one assignment;
- precision, recall, F1;
- Wilson intervals for precision and recall;
- case-bootstrap F1 intervals;
- per-domain exact and relaxed summaries.

If no `gold_items` are present, the scorer exits unscored rather than producing fake benchmark numbers.

## BioScope Assertion Runners

BioScope assertion evaluation is intentionally a collapsed sentence-label task, not the standard BioScope scope-boundary task.

```bash
npm run benchmark:bioscope -- --input "<bioscope>/abstracts.xml;<bioscope>/full_papers.xml" --target-mode sentence --out results/bioscope-assertions.json
npm run benchmark:bioscope:baselines -- --input "<bioscope>/abstracts.xml;<bioscope>/full_papers.xml" --target-mode sentence --out results/bioscope-baselines.json
npm run benchmark:bioscope:conformal -- --input "<bioscope>/abstracts.xml;<bioscope>/full_papers.xml" --target-mode sentence --alpha 0.10 --out results/bioscope-conformal.json
```

Use `--target-mode sentence` for the primary public result. `--target-mode scope` is a scope-assisted diagnostic because it supplies BioScope `xcope` text to the detector. Do not use the scope-assisted number as the headline assertion benchmark.

The baseline runner compares majority-present, NegEx-style, ConText-style, and HandoffLens assertion methods on the same collapsed task. The included NegEx/ConText rows are transparent approximations, not official pyConTextNLP package results.
