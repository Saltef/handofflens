# Evaluation Plan

Public-facing note: this document explains the evaluation layers behind HandoffLens. It is meant for technical readers who want to understand what each metric can and cannot prove.

## Goal

Compare deployable model configurations for a concrete clinical NLP use case: extracting hospital-course changes that matter for follow-up care.

The evaluation asks two questions: which configurations reliably produce valid structured output, and among valid outputs, which configurations extract the right facts without inventing unsupported clinical claims?

The primary clinical quality framework is adapted from Moore M, Bain-Donohue S, Barry M, Gray P. "It sounds like a good handover but can I trust it: the correlation between perceived quality and accuracy?" MedEdPublish. 2021 Apr 28;10:102. doi: 10.15694/mep.2021.000102.1. PMID: 38486591; PMCID: PMC10939514.

## Configurations

Primary configurations:

- Cohere Command A+ routed configuration: `cohere-aplus:command-a-plus-05-2026`
- Claude Haiku 4.5: `anthropic/claude-haiku-4.5`

Historical/optional baseline configurations:

- Claude Opus: `anthropic/claude-opus-4.8`
- Claude Sonnet: `anthropic/claude-sonnet-4.6`

## Task

Each configuration receives:

- case metadata
- de-identified discharge summary
- extraction instructions
- a target JSON schema

Each configuration returns:

- medication changes
- diagnosis changes
- procedures and tests
- abnormal labs
- follow-up actions
- safety flags
- uncertain items
- a two-page physician summary

## Case Sets

The project uses two different case sets:

- `eval/pilot_reference_cases.json`: two fully synthetic software fixtures with expected extraction labels. They test mechanics and are not an independently clinician-adjudicated gold standard.
- `eval/dataset_sample_*.json`: local unlabeled samples generated from `clinical_cases.csv.gz`; ignored by Git and used for feasibility, schema validity, latency, and qualitative review.

Generate a 20-case local sample:

```bash
npm run sample:dataset
```

Generate a larger or full local sample:

```bash
node scripts/sample-dataset.js --input clinical_cases.csv.gz --limit 200 --out eval/dataset_sample_200.json
node scripts/sample-dataset.js --input clinical_cases.csv.gz --limit 100 --out eval/dataset_sample_100.json
node scripts/sample-dataset.js --input clinical_cases.csv.gz --limit all --out eval/dataset_sample_all.json
```

Unlabeled dataset runs should not report F1. They answer whether the workflow scales operationally. Strong extraction-quality claims require a blinded, trained-annotator-adjudicated source-fidelity reference set.

For the current scaled experiment, use the 300-case representative feasibility cohort plus the 50-case clinician-review subset. See the archived representative-cohort notes and `human-in-the-loop-map.md`.

## Metrics

The evaluation has two layers. This is important because Cohere Command A+ and Claude do not currently use the same schema-enforcement mechanism.

### Layer 1: Configuration Feasibility

This layer asks whether a model-provider-schema setup is usable as a workflow.

Metrics:

- cases attempted
- cases completed
- API/provider failure rate
- JSON parse failure rate
- schema-shape validation failure rate
- latency

Configurations that cannot consistently return parseable, schema-valid outputs should not be treated as clinically ready even if an occasional successful output looks good.

### Layer 2: Automated Extraction Metrics

For completed, schema-valid outputs, the harness scores extraction fields against pilot reference annotations:

- precision
- recall
- F1
- category-level F1

Each pilot reference case contains expected items by category, for example:

- `medication_changes.started`
- `medication_changes.changed`
- `diagnosis_changes.new_or_changed`
- `procedures_and_tests`
- `labs`
- `follow_up_actions`
- `safety_flags`

The runner flattens each model's extracted `label` values, normalizes punctuation/casing/common filler terms, and performs partial string matching against the expected reference labels.

For each category:

- true positive: expected item matched by a model label
- false positive: model label not matched to the reference set
- false negative: reference item not found by the model

It then calculates:

- precision = true positives / predicted items
- recall = true positives / expected items
- F1 = harmonic mean of precision and recall

The evaluator reports two automated matching views:

- **Strict F1** uses normalized containment matching and remains the primary automated pilot score.
- **Relaxed F1** is a diagnostic score that allows strict matching or conservative token F1 >= 0.67 after limited unit/stopword normalization.

Relaxed F1 is included to expose scorer brittleness in cases such as dose-change labels that are semantically equivalent but phrased differently. It should not replace strict scoring, typed provenance, or adjudicated review.

### Safety Flag Target Definition

`safety_flags` is now typed and intentionally narrower than broad clinical risk.

Each safety flag must include `safety_type`:

- `return_precaution`
- `monitoring_instruction`
- `medication_safety`
- `pending_or_critical_result`
- `source_stated_risk`

The key scoring boundary is atomic source support. A source instruction such as "Return promptly for fever, spreading redness, increasing drainage, or severe pain" should produce separate return-precaution items, not a broad label such as "wound monitoring for signs of infection." Clinically plausible but unstated risks belong in `uncertain_items`, not `safety_flags`.

This choice trades away implicit-risk recall in favor of source-grounded precision and clearer omission analysis. That is the right trade-off for the public HandoffLens task because the project is evaluating extractive handoff reliability, not autonomous clinical risk prediction.

Safety scoring is type-aware. When the reference safety item has a `safety_type`, a predicted item must match both the label and the safety type. Reports include safety subtype rows so a missed `monitoring_instruction` is not hidden inside aggregate safety F1.

### Handoff Atom Layer

The current schema includes `handoff_atoms` as an atom-first design layer. Atoms preserve source-grounded action, target, timing, threshold, owner, instruction kind, safety type, and derived views. Compatibility fields such as `follow_up_actions` and `safety_flags` remain in the schema, but the evaluator now reports whether atom-derived view expectations are actually represented in those fields.

This is a bridge design. The evaluator now performs deterministic atom/view canonicalization after schema validation: atoms can project into missing compatibility items, and source-quoted compatibility items can backfill atoms. Reports show raw-model F1 separately from post-canonicalization system F1. This prevents a projection failure such as a lab-monitoring atom appearing as a follow-up action while missing from safety flags from being silently counted as a final system omission.

Trade-off: canonicalization can repair representation mismatches, but it cannot discover a source fact that the model failed to extract anywhere. Those omissions require better extraction, a constrained coverage critic, or human review.

### Layer 2: Manual Clinical Handover Review

The manual review rubric is stored in `eval/clinical_handover_rubric.json` and documented in `clinical-handover-evaluation.md`.

Before checking the source discharge summary, the reviewer scores:

- case/patient context
- main clinical problem identification and prioritization
- focused relevant history
- relevant observations, labs, tests, procedures, and discharge status
- logical assessment
- clear follow-up recommendation
- global confidence that the reviewer received an accurate picture

After checking the source discharge summary, the reviewer scores:

- source-record match
- handover safety

This order is intentional. Moore et al. emphasize that a handover may sound good while still being inaccurate or unsafe after verification.

### What the automated score does not judge

The current automated score does not fully grade:

- whether `source_quote` is the best evidence quote
- whether the generated `two_page_summary` is readable
- whether an omission is clinically minor or dangerous
- whether the rationale is clinically well phrased
- whether a false positive is a harmless duplicate or a serious hallucination
- whether the handover merely sounds good versus truly matches the source record

Recommended manual review additions:

- hallucination count
- source quote quality
- clinical usefulness rating
- severity-weighted miss rate

Suggested 1-5 manual rubric:

- factual grounding: every claim supported by a source quote
- clinical completeness: captures follow-up-critical items
- medication safety: accurately handles starts, stops, dose/duration changes, and uncertainty
- prioritization: highlights the issues a physician should see first
- summary usability: concise, readable, and clinically neutral

## Run

```bash
npm run check
npm run eval
```

For provider-specific benchmark claims, run the model-evidence validator after the eval:

```bash
node scripts/validate-model-evidence.js --input results/model-eval.json --require-scored
```

This post-run gate rejects missing-key, authorization-failed, row-error, zero-completion, unscored, or provider-error runs. A failed validator means the artifact may be useful for debugging the evaluation path, but it must not be reported as model performance.

Required environment variables:

```bash
OPENROUTER_API_KEY=...
COHERE_API_KEY=...
```

Run the current matched comparison configuration:

```bash
EVAL_MODELS=cohere:command-a-plus-05-2026,anthropic/claude-haiku-4.5 npm run eval
```

The runner uses OpenRouter Chat Completions with `response_format.type = "json_schema"` and `provider.require_parameters = true` for Claude. The frozen Command A+ configuration uses Cohere native JSON Schema first and strict-tool fallback after failed local validation. Budgets and attempts are defined in `eval/experiment_manifest.json`.

## Interpretation

For a clinical use case, the winner is not simply the model with the prettiest summary or the highest successful-case F1. Prefer the configuration with:

- reliable completion and schema-valid output
- high recall on follow-up-critical facts
- low hallucination rate
- strong source quote grounding
- acceptable latency and cost

Because providers expose different schema controls, claims should be phrased as configuration comparisons, such as `Claude Haiku 4.5 via OpenRouter strict JSON schema` versus `Command A+ via Cohere loose tool calling plus local validation`.

See `docs/experiment-design.md` for the full experimental design, reproducibility plan, and threats to validity.
