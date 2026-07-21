# Probabilistic Model Boundaries

Public-facing note: this document explains where probabilistic LLM behavior is useful and where deterministic checks or human review are necessary. It frames design boundaries for technical readers.

## Core Framing

HandoffLens uses probabilistic language models where they are strong:

- compressing long text
- extracting repeated clinical entities
- organizing narrative hospital courses
- identifying likely follow-up-relevant changes
- drafting a readable handoff

The project also builds explicit safety boundaries where probabilistic models are weak:

- they can produce unsupported claims
- they can omit low-frequency high-harm details
- they can overstate uncertain facts
- they can misclassify medication starts, stops, or dose changes
- they can treat absence of documentation as absence of risk
- they can produce empty or malformed outputs

The goal is not to remove probability from clinical support. The goal is to put probability in the right part of the workflow.

## Why Highest Probability Is Not Enough

Clinical decision-making is not simply selecting the most likely interpretation.

Many clinical decisions are risk-sensitive. A low-probability but high-harm possibility may deserve more attention than a high-probability benign explanation. A discharge handoff can be mostly correct and still unsafe if it misses one critical anticoagulation decision, antibiotic stop date, oxygen requirement, pending culture, wound-care need, or renal dosing issue.

This is why the experiment should not evaluate summaries only by fluency or average extraction accuracy. It should evaluate:

- safety-critical recall
- uncertainty visibility
- source contestability
- unsupported claims
- missing follow-up
- human review triggers
- automation risk

## Boundary Table

| Domain | Probabilistic model role | Human boundary |
| --- | --- | --- |
| Medication changes | Extract candidate starts, stops, dose changes, duration changes, and high-risk drugs | Clinician verifies medication reconciliation and clinical significance |
| Diagnosis changes | Draft admission-to-discharge problem delta | Clinician resolves chronic, incidental, resolved, and new diagnoses |
| Labs and tests | Highlight abnormal or follow-up-relevant values | Clinician judges whether values require action |
| Procedures | Extract procedures, dates, results, and follow-up implications | Clinician checks procedural relevance and pending needs |
| Follow-up actions | Extract explicit appointments, timeframes, and monitoring needs | Clinician judges completeness and appropriateness |
| Safety flags | Surface common high-risk patterns | Clinician reviews low-probability high-harm risks |
| Sparse notes | State missing information and uncertainty | Clinician returns to source record or EHR context |
| Conflicting source text | Preserve ambiguity and avoid definitive claims | Clinician adjudicates the conflict |
| Summary generation | Draft a readable handoff from source-grounded facts | Clinician verifies before use in care |

## Evaluation Additions

The probabilistic boundary layer asks:

- Where did the model reduce information burden?
- Where did it make unsupported or overconfident claims?
- Where did it appropriately mark uncertainty?
- Where did it miss low-probability but high-harm information?
- Would the output trigger appropriate clinician review?
- Could the output invite unsafe over-reliance?

These dimensions are stored in:

```text
eval/probabilistic_boundary_review.json
```

## Model Failure Categories

### Acceptable With Review

Some failures are acceptable in a draft-support tool if they are visible:

- clearly marked uncertainty
- missing information explicitly stated
- non-critical detail omissions
- conservative abstention
- request for source verification

### Requires Caution

Some failures require caution and should lower trust:

- vague follow-up
- incomplete medication list
- missing objective data
- ambiguous diagnosis status
- source quotes that do not support claims

### Unacceptable Without Strong Guardrails

Some failures are unacceptable if not caught by validation or clinician review:

- unsupported medication instructions
- missed anticoagulation or bleeding-risk issue
- missed antibiotic duration or infection follow-up
- missed oxygen requirement or respiratory failure
- missed renal dosing or dialysis issue
- hallucinated diagnosis or procedure
- empty summary counted as success

## How This Strengthens The Experiment

This framing makes the experiment more than a model leaderboard. It evaluates whether each model can be placed safely inside a clinician-centered workflow.

The strongest final claim is:

```text
HandoffLens evaluates where probabilistic language models can safely reduce discharge-summary review burden, and where human verification remains necessary because clinical reasoning is risk-sensitive, contextual, and not reducible to highest-probability text prediction.
```
