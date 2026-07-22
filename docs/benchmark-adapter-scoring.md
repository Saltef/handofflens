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

It reports per-case and aggregate ROUGE-1, ROUGE-2, ROUGE-L precision/recall/F1, mean prediction/reference token counts, mean compression ratio, and case-bootstrap F1 intervals. The requested `--prediction-field` is strict: rows missing that field are skipped rather than silently falling back to the transcript.

Two usage modes should remain separate:

- `--prediction-field src` is a transcript/reference overlap baseline and ingestion diagnostic.
- `--prediction-field generated_note` or another model-output field is the benchmark-shaped path for actual note-generation evaluation.

The scorer does not judge clinical factuality, hallucination, or source support. Those need separate groundedness and review checks.

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
