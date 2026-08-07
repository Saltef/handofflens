# Reproducibility

## Public, zero-cost checks

```bash
npm run check:all
npm run eval
npm run prompt:preview
```

`npm run eval` uses only the committed synthetic fixtures unless another case file is explicitly supplied.

The same public validation path is available through Docker:

```bash
docker compose --profile eval run --rm eval
docker compose --profile benchmark run --rm benchmark
```

The `eval` service runs `npm run check:all` inside a clean image built from public repository contents. The `benchmark` service runs the public benchmark unit path and mounts ignored local benchmark/output directories for explicit corpus-backed runs.

## Local configuration

Copy `.env.example` to `.env` and populate only the providers you intend to call. `.env` is ignored by Git and Docker.

The current primary routed-provider settings are:

- model: `command-a-plus-05-2026`
- response: JSON Schema
- temperature: 0
- hidden reasoning budget: 512
- maximum output tokens: 8,000
- provider retries: 0 for architecture experiments
- seed: 20260622 for v4, best-effort only

## Local data

Place the authorized local dataset at `clinical_cases.csv.gz`. Never commit it. Sampling commands write ignored files under `eval/`.

```bash
npm run sample:dataset
npm run sample:dataset:200
npm run sample:dataset:all
```

External benchmark corpora should be downloaded separately under the ignored local `benchmark_data/` directory. The Docker services mount that directory read-only at `/benchmarks`; no public or DUA-gated corpus files are copied into the image.

Example BioScope assertion, baseline, and conformal runs:

```bash
docker compose --profile benchmark run --rm benchmark npm run benchmark:bioscope -- --input "/benchmarks/bioscope/abstracts.xml;/benchmarks/bioscope/full_papers.xml" --target-mode sentence --out results/bioscope-assertions-public-text.json
docker compose --profile benchmark run --rm benchmark npm run benchmark:bioscope:baselines -- --input "/benchmarks/bioscope/abstracts.xml;/benchmarks/bioscope/full_papers.xml" --target-mode sentence --out results/bioscope-baselines-public-text.json
docker compose --profile benchmark run --rm benchmark npm run benchmark:bioscope:conformal -- --input "/benchmarks/bioscope/abstracts.xml;/benchmarks/bioscope/full_papers.xml" --target-mode sentence --alpha 0.10 --out results/bioscope-conformal-public-text.json
```

Example ACI adapter run:

```bash
docker compose --profile benchmark run --rm benchmark npm run benchmark:adapt:aci -- --input /benchmarks/aci/aci-valid.json --split valid --out results/aci-valid-records.json
docker compose --profile benchmark run --rm benchmark npm run benchmark:score:aci-note -- --records results/aci-valid-records.json --prediction-field src --bootstrap-repeats 1000 --out results/aci-valid-note-score.json
docker compose --profile benchmark run --rm benchmark npm run benchmark:aci-note:baselines -- --records results/aci-valid-records.json --split valid --bootstrap-repeats 1000 --out results/aci-valid-note-baselines.json
```

For a model note-generation run, write model outputs into a text field such as `generated_note` and use that field instead of `src`. The `src` setting is only a transcript/reference overlap baseline and ingestion diagnostic.

## Architecture experiments

```bash
npm run quality:gate:test
npm run evidence:pointer:test
npm run evidence:pipeline:v3:test
npm run candidate:v4:test
```

Dry-run commands do not call providers or print source text:

```bash
npm run evidence:pointer:dry
npm run evidence:pipeline:v3:dry
npm run candidate:v4:dry
```

Paid/local-data commands write ignored case-level artifacts:

```bash
npm run evidence:pointer:pilot
npm run evidence:pipeline:v3:pilot
npm run candidate:v4:pilot
```

Exact-source-provenance misses can be decomposed and tested for deterministic span-ID recovery without weakening the strict gate:

```bash
npm run provenance:misses -- --input results/model-eval.json --cases eval/pilot_reference_cases.json --out results/model-eval-provenance-misses.json
```

For private held-out runs, use the same command with authorized local result and case files, and keep the generated case-level JSON/Markdown outputs ignored. The taxonomy reports strict exact-span support, recovered single-span and multi-span support, provenance abstentions, lowest-performing records, source-size buckets, and entailment-ready span/hypothesis pairs. It is a triage diagnostic, not a hallucination, clinical factuality, or semantic-entailment label.

The lowest-performing evidence items can then be stress-tested with alternative parsing policies:

```bash
npm run decomposition:stress -- --input results/model-eval.json --cases eval/pilot_reference_cases.json --out results/model-eval-decomposition-stress.json --task-limit 20 --case-limit 20
```

This compares exact full-note matching, normalized full-note matching, line-span retrieval, section-filtered retrieval, and query-aware multi-span retrieval on failed exact-provenance items. For private held-out runs, commit only aggregate counts and keep the case-level output ignored.

## Human-review workflow

Review packets and method keys contain source excerpts and remain under ignored local output directories. Commit only blank schemas, protocols, and aggregate analyses.

The v2/v4 factual packet can be generated locally after the prerequisite result files exist:

```bash
npm run review:v2-v4:prepare
```

Do not open the blinded model key before annotations are complete.

## Reproducing aggregate reports

Case-level provider outputs are intentionally absent from Git. Aggregate numbers in the public ledger are therefore provenance-recorded research results, not independently executable artifacts from the public clone alone. A collaborator with authorized local data and provider access can rerun the scripts using the frozen manifests.

## Platform notes

The repository is tested on Windows PowerShell with Node.js 20+. Scripts use Node APIs and are generally platform-independent; shell examples may require syntax changes on macOS/Linux. Docker runs use Linux containers and quote semicolon-separated benchmark input paths as a single argument.
