# Claims Register

| Evidence | Allowed claim | Prohibited interpretation |
| --- | --- | --- |
| Synthetic two-case fixture | The pipeline parses, validates, and scores known fixtures | Clinical accuracy |
| Unlabeled study cohort | Completion, schema validity, route-specific latency, cost, repair burden | Precision, recall, safety, or model superiority |
| LLM-judge review | Exploratory failure taxonomy and review prioritization hypotheses | Clinician ground truth or clinical accuracy |
| Risk-enriched clinician development cohort | Failure modes, annotation refinement, judge/routing development | Population prevalence or confirmatory comparison |
| Probability-sampled independent source-fidelity test cohort | Prespecified paired semantic-fidelity endpoints with intervals | Clinical safety, appropriateness, harmfulness, or generalization beyond the study population |
| Proxy-calibrated conformal experiment | Methods feasibility for the proxy outcome | Coverage of clinical correctness |
| BioScope collapsed sentence assertion benchmark | Adjacent-domain cue-level assertion behavior with same-task baselines and explicit scope-task caveats | Clinical-note assertion validity, standard BioScope scope-boundary performance, or clinical safety |
| ACI-Bench note-generation baselines | Public ACI ingestion, native note-generation ROUGE baselines, and lexical source-support diagnostics | Official model leaderboard performance, item-extraction F1, or clinically adequate generated notes |
| ACI-Bench Command A+ note generation plus attribution repair | Benchmark-shaped evidence that model notes beat deterministic extractive baselines on ROUGE and that compact source-span repair retains most ROUGE-L while reducing unsupported-sentence flags under a lexical proxy | Official ACI-Bench leaderboard performance, semantic factuality proof, solved source-grounded clinical generation, or treating `1.0000` lexical support as independent proof of grounding |
| Annotator-calibrated held-out fidelity routing | Selective source-fidelity risk under stated assumptions | Clinical or autonomous safety |
| Fixed-output fidelity ablation on development labels | Select evidence-verification threshold and expose error-yield tradeoffs | Confirmatory clinical mitigation effectiveness |
| Locked evidence policy on independent source-fidelity labels | Held-out semantic-error detection and review burden | Improved patient outcomes or clinical safety |
| Adjudicated item-level gold set | Precision, recall, F1, and domain-specific false-positive/false-negative counts for explicit reviewed targets | Clinical safety, external validity, or population prevalence if the set is risk-enriched or development-selected |

All existing results generated before protocol version 1.0 are exploratory.

## Evidence Needed For Stronger Claims

- Entailment-backed source support: lexical overlap should be replaced or supplemented with a factuality/entailment scorer, such as MiniCheck, AlignScore, or a clinical NLI comparator, followed by manual review of disagreements.
- In-domain clinical assertion validation: the target-aware item-quote behavior must be measured on clinical-note text, not only BioScope biomedical literature. Suitable paths are DUA-controlled i2b2/n2c2 data or private adjudicated clinical gold.
- Human source-fidelity labels: automated gates and LLM judges can prioritize review, but stronger source-fidelity claims require independent human labels with intervals.
