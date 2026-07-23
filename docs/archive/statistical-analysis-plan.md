# Statistical Analysis Plan

Public-facing note: this is a methods appendix for future source-fidelity evaluation. It is not a claim that clinical validation is complete. It explains what would be required to turn the current engineering result into a stronger labeled evaluation.

## Status

Version 1.0 applies prospectively to runs created after this plan and `eval/experiment_manifest.json` are frozen. Earlier results are exploratory development evidence.

## Estimands

The engineering estimand compares complete deployable configurations, including provider, schema path, retry policy, validation, and fallback. First-pass completion and policy-assisted completion are reported separately.

The source-fidelity estimand is the paired difference between configurations in the probability that an output contains at least one semantic error relative to the supplied discharge summary. Clinical harmfulness, appropriateness, actionability, and safety are outside scope.

## Analysis Unit And Cohorts

- Sampling, splitting, uncertainty estimation, and inference use `subject_id`.
- No subject may occur in more than one development, calibration, or test partition.
- Near-duplicate and copied-forward note clusters may not cross partitions, even when subject identifiers differ.
- The risk-enriched LLM-judge/review cohort is development evidence and cannot estimate population prevalence.
- The confirmatory test cohort is probability sampled and remains untouched until prompts, schemas, configurations, judge thresholds, routing rules, and annotation guidance are locked.

## Endpoints

Primary engineering endpoints:

- first-pass valid-output rate;
- policy-assisted valid-output rate;
- paired completion difference;
- latency and cost, stratified by route and attempt.

Primary source-fidelity endpoint:

- output contains at least one adjudicated semantic source-fidelity error in an included claim, asserted relationship, explicit required extraction target, or narrative summary.

Secondary endpoints include medication-change recall, follow-up-action recall, unsupported claims, explicit-target omissions, narrative-summary semantic errors, review time, and category-specific fidelity. No clinical safety or appropriateness endpoint is collected.

## Sample Size

No fixed case count is justified by convention. Before drawing the confirmatory cohort, use blinded pilot rates to simulate the paired design. Choose the smallest patient count that satisfies both:

- the planned 95% interval width for the primary error rate and paired risk difference; and
- at least 80% power for the smallest clinically meaningful paired difference.

The primary binary endpoint is collapsed once per model output, so claims are not analyzed as independent observations. Sample-size simulation uses the two marginal error rates and their joint rate, which determine the paired discordant-cell probabilities. Inflate the selected analyzable-patient count by a frozen 10% reserve for incomplete or non-assessable paired annotations. Prespecified subgroup analyses are interval-only secondary analyses and are not separately powered.

Use `npm run plan:sample-size -- --error-a 0.30 --error-b 0.15 --error-both 0.10 --half-width 0.10 --power 0.80 --attrition 0.10 --out results/confirmatory-sample-size-plan.json` with assumptions replaced by blinded probability-pilot source-fidelity estimates. The selected `n` is analyzable paired patients; `target_generated_pairs` includes attrition. Record the assumptions and output with the frozen protocol.

The existing development packet is risk enriched and cannot supply unbiased marginal or joint error rates for sample-size planning. Label a probability-sampled source-fidelity pilot drawn from the locked reservoir and permanently exclude those patients and duplicate clusters from final validation. Pilot outcomes may estimate nuisance parameters but may not enter the final comparison.

## Annotator Assignment And Agreement

The recommended minimum staffing is two trained source-fidelity annotators and one independent adjudicator. Both blinded outputs for a patient are assigned to the same annotator. At least 20% of patients are independently reviewed by both primary annotators; remaining patients are balanced between them. Agreement is calculated before adjudication using raw agreement, positive agreement, negative agreement, and Gwet AC1. Original labels are immutable. If the approved expansion threshold is crossed, increase independent overlap according to the frozen assignment rule; do not modify the rubric after validation annotation begins.

## Inference

- Report numerator, denominator, point estimate, and 95% interval for every proportion.
- Use Wilson intervals for single proportions.
- Use patient-level paired bootstrap intervals for paired risk differences and continuous/ordinal paired summaries.
- Report a paired exact test for the binary primary endpoint as a sensitivity analysis.
- Never infer superiority from overlapping or non-overlapping marginal confidence intervals.
- Atomic claims are clustered within outputs and must not be treated as independent observations.
- Model calls are paired by case and interleaved in deterministically counterbalanced order to reduce time-of-run provider confounding.
- Missing model outputs count as engineering failures. Source-fidelity analyses report successful-output fidelity separately from a composite availability analysis.

## Multiplicity And Subgroups

Prespecified subgroups are limited to medication-intensive, renal/dosing, anticoagulation/bleeding, respiratory/oxygen, wound/device, and age 80-plus. Report subgroup sample size and interval. All other subgroup discovery is exploratory. No subgroup guarantee is claimed without adequate within-group calibration and an untouched evaluation set.

## Judge And Routing Boundaries

LLM-judge outputs are development proxies. They do not replace trained source review. Any automated fidelity judge must be validated against held-out adjudicated source-fidelity labels with sensitivity, specificity, predictive values, calibration, and subgroup results.

Conformal or selective routing is development-only until calibrated on adjudicated source-fidelity labels. It may support evidence-verification prioritization but cannot be represented as a clinical-safety layer.

## Reporting

Every report must name the manifest version, cohort role, run date, exact configuration IDs, attempts, routes, repairs, denominators, intervals, and deviations. Deviations are appended; the frozen plan is never silently edited after test-set access.

Each attempt also records provider request ID when available, returned model identifier, finish reason, input/output token usage, timestamps, request hash, source hash, route, raw schema validity, and deterministic repairs. Cost is calculated only from a versioned price snapshot applied to recorded token usage.
