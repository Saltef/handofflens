# Experiment Runbook

Public-facing note: this runbook is included for reproducibility and auditability. It describes how the experiment can be executed when private data and credentials are available; it is not required to understand the public demo.

## 1. Freeze Eligibility

Before selecting a confirmatory cohort, inventory every case used for prompt development, route selection, repair design, judge development, qualitative review, or subgroup discovery. Exclude all such patients and near-duplicate clusters.

Cases used in judge, routing, failure, comparison, or case-specific configuration work are development cases. Bulk extraction alone does not reveal the human source-fidelity endpoint.

Run the auditable exposure inventory:

```powershell
npm.cmd run audit:development
```

The tiered inventory identifies 521 direct/proxy development cases and 1,479 bulk-extraction-only cases. Exclude all 521 plus overlapping subjects and duplicate clusters. The resulting 1,399-case reservoir supports locked internal source-fidelity validation. It is not external or temporal validation.

## 2. Validate Code And Canonical Schema

```powershell
npm.cmd run check
npm.cmd run prompt:preview
```

Both provider previews must show the same 42 canonical leaf fields. Provider syntax may differ, but no provider-specific semantic field is permitted.

## 3. Build Duplicate Clusters

```powershell
npm.cmd run sample:clusters
npm.cmd run review:clusters:prepare
```

Manually inspect every multi-case cluster. Adjust the Hamming threshold only on development data and document the change. Freeze the cluster assignment file before cohort selection.

Complete `results/duplicate-cluster-review-private.csv`, using the evidence in `results/duplicate-cluster-review-private.md`, then require:

```powershell
npm.cmd run review:clusters:validate
```

## 4. Run Probability Pilot And Plan Sample Size

Draw a probability-sampled development pilot from the locked reservoir. Two trained non-clinical annotators perform blinded source-fidelity review; the pilot is permanently excluded from the final cohort. Use its adjudicated paired rates:

```powershell
npm.cmd run plan:sample-size -- --error-a 0.30 --error-b 0.15 --error-both 0.10 --half-width 0.10 --power 0.80
```

Replace the example rates with adjudicated pilot estimates. Add `--attrition 0.10 --out results/confirmatory-sample-size-plan.json`.

## 5. Draw Confirmatory Cohort

Use the bulk-only candidate file and exclude the direct/proxy development ledger. The cluster assignments cover the entire corpus, so cross-tier near duplicates are excluded:

```powershell
npm.cmd run sample:confirmatory -- --input eval/internal_validation_candidates_private.json --clusters results/note-duplicate-clusters-private.json --exclude eval/direct_development_cases_private.json --size N --seed protocol-v1 --out eval/confirmatory_test_private.json --audit results/confirmatory-cohort-audit-private.json
```

Quarantine the cohort. Do not inspect its notes or model outputs before the analysis configuration is frozen.

## 6. Preflight

```powershell
npm.cmd run preflight -- --cases eval/confirmatory_test_private.json --clusters results/note-duplicate-clusters-private.json --exclude eval/clinician_review_50.json,eval/other_development_cases.json --out results/confirmatory-preflight.json
```

All checks must pass. Commit and tag the protocol, manifest, prompts, schema, analysis code, cluster assignments hash, cohort hash, and preflight report before model calls.

## 7. Paired Smoke

```powershell
npm.cmd run smoke:paired
```

Require success from both configurations. Inspect raw schema conformance, repairs, returned model IDs, finish reasons, usage, request hashes, and per-attempt audit records.

If running a provider-specific pilot for reporting, validate the artifact before treating it as model evidence:

```powershell
node scripts/validate-model-evidence.js --input results/model-eval.json --require-scored
```

The validation command must pass before any model score is cited. Missing API keys, authorization failures, row errors, zero completed cases, unscored selected rows, or provider-error attempt audits mean the run exercised the evaluation path but is not valid model-performance evidence.

## 8. Confirmatory Model Run

```powershell
npm.cmd run batch:paired
node scripts/combine-batches.js --input-dir results/batches/paired-confirmatory --out results/paired-confirmatory-combined.json
npm.cmd run batch:split:paired -- --input results/paired-confirmatory-combined.json
```

The evaluator interleaves configurations within case and counterbalances which model runs first. Do not rerun selected cases because their output looks poor. Apply only the frozen recovery policy.

## 9. Cost Snapshot

Copy `eval/pricing_snapshot.example.json`, enter the documented prices applicable on the run date, and save it under `results/`. Then run:

```powershell
npm.cmd run results:cost -- --input results/paired-confirmatory-combined.json --pricing results/pricing-snapshot.json --out results/paired-confirmatory-costed.json
```

## 10. Source-Fidelity Review And Analysis

Blind identities, randomize/counterbalance output order, preserve missing outputs, and retain original double annotations plus adjudication. Annotators judge only support against the supplied source.

Create an exhaustive source-fidelity packet only after the paired model run is complete, then assign paired patients to two trained annotators:

```powershell
npm.cmd run review:confirmatory:prepare
npm.cmd run review:confirmatory:assign -- --input results/source-fidelity-master-packet.json --reviewers ANNOTATOR_1,ANNOTATOR_2 --double 0.20 --seed protocol-v1 --out-dir results/source-fidelity-review-assignments
```

Both blinded outputs from a patient stay with the same reviewer. After the two packets are complete, calculate agreement before adjudication:

```powershell
npm.cmd run review:agreement -- --input results/source-fidelity-review-assignments/ANNOTATOR_1-completed.json,results/source-fidelity-review-assignments/ANNOTATOR_2-completed.json --out results/source-fidelity-agreement.json
```

If the frozen expansion trigger fires, double-annotate the additional prespecified 20% before adjudication. Preserve original labels and store adjudication in a separate artifact.

LLM-judge and routing results remain development-only until validated on independent adjudicated source-fidelity labels. Do not tune thresholds on the final test set.

Clinical safety ablation is outside the revised experiment. Evidence-verification policies may be compared only against source-fidelity errors and must not be called safety mitigation.

```powershell
npm.cmd run review:fidelity:analyze -- --input results/source-fidelity-review-completed.json --key results/source-fidelity-model-key.json --out results/source-fidelity-analysis.json
```

Summarize technical recovery separately:

```powershell
npm.cmd run ablation:recovery -- --input results/paired-confirmatory-combined.json --out results/recovery-ablation.json
```
