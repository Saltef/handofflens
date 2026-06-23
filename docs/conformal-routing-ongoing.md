# Conformal and selective-routing work

This is ongoing exploratory work, not the headline validation result.

## Why it exists

The main HandoffLens result is about source-grounded extraction: schema-valid LLM output can look correct while failing exact-source provenance, and candidate-first extraction makes that failure visible.

The conformal/selective-routing scripts ask a downstream engineering question:

> Once an extraction pipeline can expose failures, can we use observable signals to decide which cases are safe to pass through, abstain, retry, or escalate for human review?

That is a useful production question for high-volume unstructured-document workflows. It is also a risky question in clinical settings, because "low risk" must not be confused with "clinically safe."

## What is implemented

The repository keeps five substantial routing/proxy-risk scripts:

- `scripts/analyze-routing.js`
- `scripts/run-conformal-pretriage.js`
- `scripts/run-conformal-routing-experiment.js`
- `scripts/run-group-specialist-pretriage.js`
- `scripts/run-overlapping-group-conformal.js`

Together, these explore:

- deterministic routing features from extraction outputs;
- proxy labels for technical failure or review need;
- split-conformal and group-aware thresholding;
- escalation/abstention trade-offs;
- whether simple global thresholds behave differently from group-conditional or overlapping-group rules.

## How to read this work

Read it as an engineering appendix for selective risk control, not as clinical validation.

The conformal scripts use proxy outcomes such as provider failure, schema failure, provenance-gate failure, routing label, or LLM-judge/review-needed signals. Those are useful for workflow design, but they are not ground-truth labels for patient safety, clinical harm, or clinical correctness.

The intended interpretation is:

> If proxy failure labels are available, conformal-style routing may help create auditable escalation policies with explicit coverage/abstention trade-offs.

The prohibited interpretation is:

> The system can identify clinically safe cases for autonomous use.

## Why it remains in the portfolio release

This work is included because it shows a second layer of reliability engineering:

1. Make model outputs source-grounded and auditable.
2. Detect when source grounding or schema validity fails.
3. Route uncertain or high-risk cases to abstention, retry, alternate extraction, or human review.

That is relevant to engineers and data scientists building LLM systems over unstructured records. It is not the core claim, but it is a credible ongoing direction.

## Current status

Status: exploratory / ongoing.

The scripts are retained and syntax-checked by `npm run check:all`. They should be treated as research scaffolding until independent factual labels or stronger proxy-label validation are available.

## Interview framing

If asked about this part of the repo, the concise answer is:

> The conformal work is a selective-routing appendix. The main result is source-fidelity measurement and candidate-first extraction. Once the system exposes failures, the next engineering question is how to route cases based on observable risk signals. The conformal scripts test that idea with proxy labels, but I do not treat those proxy labels as clinical truth.

