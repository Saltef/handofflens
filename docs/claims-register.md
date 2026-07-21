# Claims Register

| Evidence | Allowed claim | Prohibited interpretation |
| --- | --- | --- |
| Synthetic two-case fixture | The pipeline parses, validates, and scores known fixtures | Clinical accuracy |
| Unlabeled study cohort | Completion, schema validity, route-specific latency, cost, repair burden | Precision, recall, safety, or model superiority |
| LLM-judge review | Exploratory failure taxonomy and review prioritization hypotheses | Clinician ground truth or clinical accuracy |
| Risk-enriched clinician development cohort | Failure modes, annotation refinement, judge/routing development | Population prevalence or confirmatory comparison |
| Probability-sampled independent source-fidelity test cohort | Prespecified paired semantic-fidelity endpoints with intervals | Clinical safety, appropriateness, harmfulness, or generalization beyond the study population |
| Proxy-calibrated conformal experiment | Methods feasibility for the proxy outcome | Coverage of clinical correctness |
| Annotator-calibrated held-out fidelity routing | Selective source-fidelity risk under stated assumptions | Clinical or autonomous safety |
| Fixed-output fidelity ablation on development labels | Select evidence-verification threshold and expose error-yield tradeoffs | Confirmatory clinical mitigation effectiveness |
| Locked evidence policy on independent source-fidelity labels | Held-out semantic-error detection and review burden | Improved patient outcomes or clinical safety |
| Adjudicated item-level gold set | Precision, recall, F1, and domain-specific false-positive/false-negative counts for explicit reviewed targets | Clinical safety, external validity, or population prevalence if the set is risk-enriched or development-selected |

All existing results generated before protocol version 1.0 are exploratory.
