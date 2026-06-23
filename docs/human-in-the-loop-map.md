# Human-in-the-Loop Map

Public-facing note: this map describes review responsibilities for a possible workflow. It is a governance and design appendix, not a deployment claim.

## Purpose

HandoffLens is designed as a clinician-reviewed draft handoff workflow, not an autonomous discharge decision system. The model is used for probabilistic extraction, organization, and summarization. Human review is required wherever the output could affect clinical interpretation, prioritization, or follow-up action.

This map separates three levels:

| Level | Meaning | Examples |
| --- | --- | --- |
| Automated | Can be performed by code or model without clinical judgment | Schema validation, latency tracking, empty-summary detection |
| Human review required | Clinician or trained reviewer must inspect before using results for claims | Source support, missed safety items, handoff quality scores |
| Human sign-off required | Output cannot be used clinically without final clinician responsibility | Medication reconciliation, follow-up plan, safety-critical actions |

## Workflow Boundaries

| Workflow step | Automated role | Human-in-the-loop requirement | Why |
| --- | --- | --- | --- |
| Case sampling | Select representative cases by length and metadata features | Review sampling plan | The sample should represent the dataset and avoid cherry-picking. |
| Model generation | Produce structured extraction and physician handoff draft | No human needed for generation itself | Generation is only a draft artifact. |
| Schema validation | Check required fields, source quote fields, non-empty summary, array structure | Human review only if repeated schema failures suggest prompt or model instability | Schema validity does not prove clinical accuracy. |
| Retry policy | Retry failed or truncated outputs with predefined settings | Review retry rules before analysis | Retry rules can bias feasibility results if changed after seeing outcomes. |
| Source quote presence | Verify each item contains a source quote field | Human review required for quote adequacy | A quote can be present but not actually support the claim. |
| Medication changes | Extract starts, stops, dose changes, continued medications, uncertain medications | Human sign-off required | Medication reconciliation is safety-critical and absence from a list may not mean discontinuation. |
| Diagnosis changes | Extract admission diagnosis, discharge diagnoses, new or changed problems | Human review required | Models can misclassify chronic, resolved, incidental, suspected, or ruled-out conditions. |
| Labs and tests | Extract abnormal or follow-up-relevant labs, imaging, cultures, pending studies | Human review required | Clinical relevance depends on context, trend, severity, and follow-up plan. |
| Procedures | Extract procedures and important findings | Human review required | The model may miss why a procedure matters or whether follow-up is needed. |
| Follow-up actions | Extract appointments, monitoring needs, pending tests, and safety concerns | Human sign-off required before clinical use | Follow-up plans must be complete, feasible, and appropriate for the patient. |
| Safety flags | Surface high-risk issues such as anticoagulation, antibiotics, oxygen, renal dosing, wounds, pending cultures, or abnormal discharge status | Human sign-off required | Low-frequency high-harm omissions are exactly where probabilistic summaries are weakest. |
| Uncertainty handling | Separate uncertain items from definitive claims | Human review required | Clinicians must adjudicate ambiguous or conflicting source text. |
| Summary readability | Draft a concise, sectioned handoff | Human review required for claims about usefulness | Fluency can mask omissions or unsupported synthesis. |
| LLM-as-judge scoring | Score handoff quality, source match, safety, and collaboration dimensions | Human review required; judge is supportive, not final truth | A judge model can reproduce model biases or miss subtle clinical errors. |
| Manual 50-case review | Clinician scores paired summaries against source records | Human required | This is the primary clinical-quality evidence layer. |
| Final model comparison | Compare feasibility, latency, schema validity, judge scores, and manual review | Human interpretation required | The best model depends on workflow tradeoffs, not only a single metric. |
| Clinical deployment | Use output in care | Human sign-off required | HandoffLens is not validated for autonomous patient-care decisions. |

## Mandatory Human Review Triggers

Any output should be routed to human review if one or more of these conditions occurs:

- The model output failed schema validation and was repaired or retried.
- The summary is unusually short for a long or complex discharge summary.
- Medication changes include stopped, changed, anticoagulation, insulin, opioids, antibiotics, steroids, antiepileptics, immunosuppression, or renal-dose-sensitive drugs.
- Source text contains pending cultures, pending imaging, biopsy/pathology, follow-up appointments, wound care, oxygen needs, dialysis, anticoagulation, or abnormal discharge vitals/labs.
- The model marks an item as uncertain.
- The model gives a follow-up action without a clear source quote.
- The generated summary includes a diagnosis, procedure, medication instruction, or safety concern not clearly supported by the structured fields.
- Cohere and Claude disagree on a safety-critical item.
- The case belongs to a known failure-prone subgroup such as very long discharge summaries, dense medication lists, ICU courses, multiple procedures, or sparse notes.

## What The Model Can Decide

The model may decide:

- how to organize the handoff draft
- which source-supported facts appear candidate-relevant for follow-up
- which items should be marked uncertain
- which evidence quote to attach to each extracted item
- whether the output can be parsed into the required schema

These are drafting and information-processing decisions, not clinical decisions.

## What The Model Must Not Decide

The model must not be treated as deciding:

- whether a medication should be continued, stopped, or changed in real care
- whether a diagnosis is clinically active or resolved
- whether a lab abnormality requires treatment
- whether a pending test requires urgent action
- whether follow-up timing is clinically sufficient
- whether a handoff is safe for patient care without clinician review
- which model is clinically superior based only on fluency, completion rate, or automated judge scores

## Review Responsibilities

### Automated Evaluator

The automated evaluator should report:

- completion rate
- failure rate
- empty-summary rate
- schema-repair rate
- latency
- retry recoveries
- extraction categories present or missing
- model disagreements

### LLM Judge

The LLM judge may help screen:

- handoff structure
- apparent source match
- possible safety omissions
- uncertainty visibility
- collaboration risk

Its scores should be treated as triage signals for human review, not as clinical ground truth.

### Clinician Reviewer

The clinician reviewer should adjudicate:

- whether source quotes support the extracted claims
- whether medication changes are accurate and complete
- whether high-risk follow-up issues were missed
- whether diagnoses are prioritized appropriately
- whether the summary gives an accurate clinical picture
- whether omissions or unsupported claims could create safety risk

## Product Boundary Statement

HandoffLens can reduce the burden of reviewing long discharge summaries by generating source-grounded draft handoffs and highlighting candidate changes. It should require clinician verification before use because clinical follow-up decisions are risk-sensitive, contextual, and not reducible to highest-probability model output.
