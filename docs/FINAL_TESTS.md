# Validation roadmap and final engineering tests

This document explains what the current automated checks prove, what they do not prove, and which tests would most improve the evidence base.

## What the current checks prove

The public validation suite checks:

- JavaScript syntax;
- schema and protocol consistency;
- deterministic source-pointer indexing;
- extraction quality-gate behavior;
- candidate-first v4 mechanics;
- share-readiness and private-data exclusion.

These checks are meaningful software and reliability tests. They do not prove clinical correctness, clinical usefulness, omitted-fact safety, or generalization.

## Highest-value remaining tests

| Test | Why it matters | Human review required? |
| --- | --- | --- |
| Factual review of v2/v4 evidence packet | Distinguishes recovered evidence from over-extraction. | Yes, non-clinician factual review is sufficient. |
| Review of remaining negation flags | Determines whether proxy-audit warnings are true errors or conservative flags. | Yes. |
| Larger stability run | Tests repeatability across more cases and perturbations. | No. |
| Judge repeatability and bias checks | Keeps LLM-as-judge from becoming hidden ground truth. | No, but human labels are needed for validation. |
| Cost and latency budget tracking | Makes deployment trade-offs explicit. | No. |
| External cohort evaluation | Tests generalization. | Yes, requires data access and labels. |
| Clinician review | Supports clinical importance and safety claims. | Yes, qualified clinical reviewers required. |

## Current best claim

The strongest current claim is:

> HandoffLens demonstrates an engineering framework for measuring and reducing unsupported LLM extraction from discharge-summary-style text. Candidate-first extraction, deterministic provenance gates, abstention, and extractive rematerialization make source-fidelity failures visible and reviewable.

The current artifact should not be described as clinical validation.
