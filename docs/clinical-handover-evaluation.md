# Clinical Handover Evaluation

Public-facing note: this is a rubric appendix. It explains what a future clinical-handover review would need to assess; it is not evidence that the current system is clinically validated.

## Primary Source

This project adapts the handover assessment approach described in:

Moore M, Bain-Donohue S, Barry M, Gray P. "It sounds like a good handover but can I trust it: the correlation between perceived quality and accuracy?" MedEdPublish. 2021 Apr 28;10:102. doi: 10.15694/mep.2021.000102.1. PMID: 38486591; PMCID: PMC10939514.

Open access: https://pmc.ncbi.nlm.nih.gov/articles/PMC10939514/

## Why This Rubric Fits Better

The model output in this project is a physician-facing hospital course and follow-up summary, so the evaluation is framed as clinical handover quality, accuracy, and safety.

The Moore et al. framing is especially useful because it separates:

- perceived quality: whether the handover sounds complete and organized before checking the patient/source record
- accuracy: whether the received picture matches the patient/source record after verification
- safety: whether omissions or distortions could create patient-safety risk

That distinction matters for LLM evaluation. A generated summary can sound polished while still omitting a high-risk medication change, abnormal lab, pending test, or follow-up need.

## Project Adaptation

Because this dataset is de-identified discharge-summary text, not a live observed handover, the rubric is adapted from bedside/clinical handover to source-record review.

The primary adaptation is:

> How closely did the model summary match the source discharge summary?

The reviewer first scores the generated summary as a handover artifact. Then the reviewer compares it with the source discharge summary and reference labels to score accuracy and safety.

## Review Domains

Before source-record review:

- identifies case and patient context
- identifies and prioritizes main clinical problems
- provides focused relevant history
- reports relevant examination, observations, labs, imaging, procedures, and discharge status
- makes a logical assessment
- provides clear follow-up recommendations for clinician review
- global confidence that the reviewer received an accurate picture

After source-record review:

- source-record match
- handover safety

The full adapted scoring matrix is stored in `eval/clinical_handover_rubric.json`.

## Relationship to Automated Metrics

This handover rubric is a manual clinical quality measure. It complements but does not replace automated extraction metrics.

Automated metrics answer:

- Did the model extract expected medications, diagnoses, labs, procedures, follow-up actions, and safety flags?
- What were precision, recall, and F1?
- Did the model follow the JSON schema?
- How long did the model take?

Manual handover review answers:

- Did the summary give a coherent and prioritized clinical picture?
- Did the summary sound good but fail to match the source record?
- Were there safety-relevant omissions or hallucinations?
- Would a clinician trust this as a follow-up handover after verifying it?

## Human-AI Collaboration Add-On

The handover rubric evaluates clinical communication quality, accuracy, and safety. A separate human-AI collaboration layer evaluates whether the model output supports appropriate clinician judgment.

That layer is adapted from Li and Tian's 2026 conceptual framework on AI-human collaborative decision-making and is documented in `docs/human-ai-collaboration-framework.md`.

It asks whether the summary:

- preserves clinician decision authority
- reduces cognitive load without hiding uncertainty
- makes claims contestable against the source note
- calibrates trust by marking missing or uncertain information
- fits a physician follow-up workflow
- avoids unsafe automation or over-reliance

## Probabilistic Boundary Add-On

The handover rubric should also be read alongside `docs/probabilistic-model-boundaries.md`. That layer asks whether the model is being used where probabilistic text systems are strong, while preserving safety boundaries where they are weak.

For clinical handoff review, the highest-probability summary is not necessarily the safest summary. Reviewers should therefore pay special attention to low-frequency high-harm omissions, such as anticoagulation decisions, antibiotic duration, oxygen requirements, renal dosing, pending cultures, wound care, and urgent follow-up.
