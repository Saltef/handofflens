# Protocol Freeze

Public-facing note: this is a methods appendix. It records how the project separates exploratory engineering evidence from stronger validation claims. It is included so engineers and data scientists can audit the study discipline behind the portfolio result.

## Version And Scope

Protocol version 1.0 applies prospectively to runs created after this document, `eval/experiment_manifest.json`, and `docs/statistical-analysis-plan.md` are committed and tagged. All earlier results are exploratory development evidence.

The study asks two separate questions:

1. Which complete deployable configuration has better technical feasibility under its prespecified recovery policy?
2. On paired, blinded, adjudicated outputs, what is the difference in semantic source-fidelity error risk?

It does not assess clinical harmfulness, appropriateness, actionability, or safety for patient care.

## Frozen Configurations

The authoritative configuration definitions are in `eval/experiment_manifest.json`:

- `cohere-aplus-routed-v1`: Command A+ through Cohere, native JSON Schema primary, strict-tool fallback, fixed budgets.
- `claude-haiku45-strict-v1`: Claude Haiku 4.5 through OpenRouter strict JSON Schema, fixed budgets.

Provider retries, local validation attempts, fallbacks, token budgets, prompts, schema, model identifiers, and run dates are reported. First-pass and policy-assisted results are always separate. A system comparison is not represented as an isolated model-weights comparison.

## Frozen Cohort Roles

- Unlabeled feasibility cohort: technical completion, validation, latency, cost, and repair burden only.
- Risk-enriched LLM-judge/review cohort: annotation development and failure discovery only.
- Locked source-fidelity test cohort: probability sampled by `subject_id`, independent of development and calibration, and untouched until all rules are locked.

No subject may cross cohort or partition boundaries. The final test sample size is selected by the simulation procedure in the statistical analysis plan, not by a conventional target number.

## Frozen Prompt, Schema, And Review

- `prompts/system.md`
- `prompts/clinical-extraction.md`
- `eval/schema.json`
- `eval/source_fidelity_review_schema.json`
- `docs/source-fidelity-review-protocol.md`

The primary endpoint is any semantic error relative to the supplied source: unsupported or partially supported facts, incorrect asserted relationships, omitted explicit required targets, or unsupported narrative-summary assertions. Trained annotators remain blinded to model identity. Both outputs for a patient remain with the same annotator. At least 20% of patients are double annotated. Report raw, positive, and negative agreement plus Gwet AC1 before adjudication. Clinical severity and safety are not collected.

## Technical Outcome Rules

A first-pass output is valid only if the request succeeds, JSON parses, schema-shape validation passes, and the summary is non-empty and at least 80 trimmed characters. Repairs and fallbacks are separate routes.

- Full-extraction repair may count toward policy-assisted completion after complete validation.
- Summary-only repair counts only toward summary availability.
- Unrecovered outputs remain technical failures.
- Fidelity reports show successful-output quality and a separate composite availability analysis that includes unrecovered failures.

## Judge And Routing Rules

Judging is blinded by default. LLM-judge results remain exploratory until validated against held-out adjudicated source-fidelity labels. Judge agreement alone is insufficient; sensitivity, specificity, predictive values, calibration, and subgroup behavior are required.

Proxy-calibrated conformal results concern the proxy outcome only. No routing result may be described as clinical-safety coverage.

## Allowed Claims

- HandoffLens is a research evaluation harness for discharge-summary extraction source fidelity.
- Unlabeled runs estimate configuration feasibility, route-specific latency, cost, and repair burden.
- Exploratory judge, routing, and conformal experiments generate hypotheses and identify failure modes.
- Locked source-fidelity results may be reported only from the independent adjudicated test cohort with denominators and intervals.

## Disallowed Claims

The project must not claim:

- clinical validation, harmfulness, appropriateness, or autonomous safety;
- that a model can replace clinician review or sign-off;
- accuracy from schema validity, fluency, proxy labels, synthetic fixtures, or LLM-judge labels;
- population prevalence from a risk-enriched review sample;
- model superiority from asymmetric configuration results;
- conformal coverage of clinical correctness when calibrated on another outcome;
- generalization beyond the study population or source-note task.

## Required Report Contents

Every report includes protocol version, cohort role, patient count, configuration IDs, provider routes, attempts, repairs, run date, endpoints, numerators, denominators, intervals, missingness, deviations, and the appropriate claims boundary. Existing pre-v1.0 reports retain an exploratory banner rather than being retroactively treated as confirmatory.
