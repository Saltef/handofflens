# Atomic Clinician Review Protocol

Public-facing note: this protocol describes a possible human-review layer for clinical claims. The current portfolio artifact prepares review workflows, but does not include completed clinician adjudication.

## Purpose

This protocol creates clinician-adjudicated labels for evaluating whether model-generated physician handoffs contain unsupported claims, incorrect clinical relationships, or clinically important omissions.

The review is performed locally. No source records, annotations, or API credentials are transmitted by the review interface.

## Review Design

The fixed review budget contains:

- 50 case-output reviews;
- 25 primary-configuration outputs;
- 25 Claude Haiku 4.5 outputs;
- 20 matched case pairs, producing 40 reviews;
- 10 additional single-output cases, producing 10 reviews;
- 30 unique patient records in total.

Model identities are reproducibly randomized between `Model A` and `Model B` from a stable case hash and stored only in a separate ignored key file. The review packet does not contain provider or model names.

Up to 12 claims are selected from each output. Selection prioritizes medication changes, machine-flagged claims, safety/follow-up claims, diagnoses, procedures, and laboratory results. This is a risk-enriched failure-analysis sample, not a probability sample. Claim-level error percentages must not be described as population prevalence.

This 50-review packet is development evidence. It may refine the taxonomy, annotation guide, judge, and routing hypotheses. It is not the confirmatory test cohort. The confirmatory cohort size is determined by the simulation procedure in `statistical-analysis-plan.md` and remains untouched until the protocol is locked.

At least 20% of confirmatory output reviews are independently labeled by two clinicians. Report raw agreement, positive and negative agreement for the binary primary endpoint, and a prespecified chance-adjusted statistic. Preserve both original annotations and record adjudication separately.

The recommended minimum confirmatory staffing is two primary clinicians plus an independent senior adjudicator. Both blinded model outputs for a patient stay with the same primary clinician. The chance-adjusted statistic is Gwet AC1. The proposed expansion threshold is positive agreement below 0.70 or Gwet AC1 below 0.60; this threshold requires approval before protocol freeze. Once confirmatory annotation starts, the rubric and original labels are immutable. A rubric change requires a versioned restart or complete re-annotation.

## Reviewer Sequence

For each output:

1. Read the model handoff before revealing the source record.
2. Reveal the source and assess each selected claim.
3. Assess factual support and relationship support separately.
4. Review each omission domain, including medication, diagnosis, procedure/test, laboratory result, follow-up, and safety information.
5. Assign source-record match, handover safety, and operational disposition.
6. Record review time and explanatory comments where useful.

The interface conceals the source by default when a case or model output is opened.

## Atomic Claim Labels

### Factual Support

| Label | Definition |
| --- | --- |
| Supported | The source supports the claim without a clinically meaningful distortion. |
| Partially supported | The core fact appears in the source, but an important qualifier, value, scope, or temporal detail is inaccurate or unsupported. |
| Unsupported | The claimed fact is absent from or contradicted by the source. |
| Not assessable | The available source is insufficient to decide. |

### Relationship Support

This field evaluates whether the source supports the claimed status or relationship, not merely the entity.

Examples include:

- a medication was started, stopped, changed, or continued;
- a diagnosis was new or changed;
- a result was pending;
- a follow-up action was explicitly required.

Use `not_applicable` when the claim does not assert a relationship requiring separate review.

### Severity

| Label | Definition |
| --- | --- |
| None | No error identified. |
| Minor | Inaccuracy unlikely to alter clinical follow-up or understanding. |
| Material | Could meaningfully alter the handoff, prioritization, monitoring, or reconciliation work. |
| Potentially harmful | Could plausibly contribute to an incorrect medication, monitoring, escalation, or follow-up decision. |

## Omission Review

An omission is present when clinically important source information is absent or materially obscured in the handoff. Record a short description and source evidence for material or potentially harmful omissions.

The absence of a selected atomic claim does not imply that the corresponding domain has no omission. Omission review uses the complete source and complete model handoff.

## Global Scores

The source-record match and handover-safety scores retain the adapted 0-3 Moore handoff scale:

- `0`: unsafe or substantially inaccurate;
- `1`: important inaccuracies or safety issues;
- `2`: mostly accurate and safe, with minor gaps;
- `3`: accurate picture with no apparent safety issue.

Operational disposition is recorded separately:

- accept as draft;
- clinician spot-check;
- full clinician review;
- reject or regenerate.

## Local Workflow

Prepare or refresh the blinded packet:

```powershell
npm.cmd run review:prepare
```

Start the local interface:

```powershell
npm.cmd run review:serve
```

Open `http://127.0.0.1:4173`. The interface saves progress in browser local storage. Export the completed review as JSON and place it at:

```text
results/atomic-clinician-review-completed.json
```

Analyze completed annotations:

```powershell
npm.cmd run review:analyze
```

The generated model key and all review packets remain under `results/`, which is excluded from Git and Docker build context.

## Interpretation Rules

- Do not use machine flags as adjudication labels.
- Do not unblind model identities until annotation is complete.
- Do not describe LLM-judge labels as clinician labels.
- Do not estimate population claim-error prevalence from the risk-enriched claim sample.
- Treat the 50 reviews as development and calibration evidence; retain an independent clinician-reviewed test set for final performance claims.
