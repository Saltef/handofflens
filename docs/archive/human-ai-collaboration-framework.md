# Human-AI Collaboration Framework for HandoffLens

Public-facing note: this framework explains how a source-grounded extraction system should fit into human review. It is included to clarify the intended human-in-the-loop boundary, not to claim production readiness.

## Source

This project integrates concepts from:

Li H, Tian F. "Advancing Decision-Making through AI-Human Collaboration: A Systematic Review and Conceptual Framework." Group Decision and Negotiation. Published 2026-04-03. Volume 35, article 26. doi: 10.1007/s10726-026-09980-1.

Open access: https://link.springer.com/article/10.1007/s10726-026-09980-1

## Why This Paper Fits HandoffLens

HandoffLens is not simply a summarization project. It is a decision-support project for a high-stakes clinical handover task.

The Li and Tian framework is useful because it treats AI-human decision-making as a dynamic allocation of cognitive work between AI and humans. That maps directly onto this project:

- The AI reads and structures long discharge summaries.
- The AI surfaces candidate medication changes, diagnoses, tests, labs, follow-up needs, and safety flags.
- The physician remains responsible for source verification, prioritization, and final clinical judgment.

The paper's central warning is also relevant: AI can expand human information-processing capacity, but it can also create new constraints if humans over-rely on algorithmic outputs or if AI output is opaque, incomplete, or miscalibrated.

## Project Classification

Using the Li and Tian framework, HandoffLens should be framed primarily as:

```text
Interpretive analytical decision support
```

It is not a fully automated clinical decision system.

### Why Interpretive Analytical?

The task requires:

- extracting structured information from heterogeneous clinical text
- interpreting hospital-course changes
- comparing admission and discharge states
- identifying uncertainty and missing information
- preserving source-grounded evidence
- supporting physician review rather than replacing it

This is more than a programmed algorithmic task because discharge summaries are variable and context-dependent. It is also not purely intuitive human decision-making because AI performs meaningful information processing. The best fit is a collaborative analytical workflow: AI organizes evidence and clinicians judge meaning, risk, and actionability.

## Decision-Making Dimensions

Li and Tian describe two dimensions that are useful for this project:

### 1. Locus of Bounded Rationality

This asks where the main limits of judgment sit:

- human-bounded: clinician has limited time, memory, and attention when reviewing long notes
- AI-bounded: model has limits in source fidelity, schema following, context interpretation, and hallucination control
- hybrid-bounded: both human and AI constraints interact

HandoffLens should explicitly acknowledge hybrid boundedness. The model may reduce clinician cognitive load, but it can introduce new failure modes such as unsupported claims, missed medication changes, or empty summaries.

### 2. Depth of Cognitive Processing

This asks whether the task is rule-like or reflective:

- rule-like: extract explicit discharge medications, dates, labs, and appointments
- analytical: prioritize problems, connect treatments to diagnoses, and identify safety-relevant omissions
- reflective: judge whether the output gives an accurate and safe clinical picture

HandoffLens spans all three. The product should therefore avoid claiming that schema-valid extraction alone is enough.

## Implications for Product Design

### 1. Keep Human Authority Explicit

The product should be described as:

```text
AI-generated draft handoff for clinician verification
```

It should not be described as:

```text
Automated discharge decision-making
```

The physician's role is not cosmetic. The clinician verifies source evidence, resolves uncertainty, and decides whether any follow-up action is clinically appropriate.

### 2. Add Contestability

A clinician should be able to challenge the AI output. In this project, contestability means:

- every extracted item includes a source quote when possible
- uncertain items are separated from definitive claims
- missing information is explicitly stated
- generated summaries should point back to structured fields and source evidence
- evaluation penalizes unsupported claims and safety-relevant omissions

### 3. Evaluate Trust Calibration

The goal is not maximum trust. The goal is calibrated trust.

A good HandoffLens output should help the clinician quickly decide:

- what seems reliable
- what needs source verification
- what is missing
- what might be safety-critical

This is why the project should report empty summaries, schema failures, source-record match, safety omissions, and unsupported claims separately.

### 4. Treat Failure Modes As Workflow Signals

Failures are not only model defects. They are signals about where human review must be emphasized.

Examples:

- medication reconciliation gap: clinician must verify medication list
- objective data gap: clinician must inspect labs, imaging, and vitals
- missing critical follow-up: clinician must verify appointments and pending tests
- unsupported claim: clinician should not trust generated synthesis without source review
- empty summary: workflow failure requiring retry or manual review

## Implications for Evaluation

The current HandoffLens evaluation already has two layers:

1. Configuration feasibility
2. Clinical extraction and handover quality

The Li and Tian framework adds a third interpretive layer:

```text
Human-AI collaboration quality
```

This layer asks whether the output supports appropriate clinician judgment rather than inappropriate automation.

Recommended review dimensions:

- decision authority: does the output preserve clinician authority?
- cognitive load: does the output reduce review burden without hiding uncertainty?
- source contestability: can claims be checked against the discharge summary?
- trust calibration: does the output show uncertainty and missing information?
- workflow fit: does it help the physician make a safer follow-up review?
- automation risk: could the output invite over-reliance?

These dimensions are stored in:

```text
eval/human_ai_collaboration_review.json
```

A related boundary-analysis layer is documented in `probabilistic-model-boundaries.md`. It focuses on where probabilistic model output is useful and where clinician verification must remain central because clinical reasoning is risk-sensitive and not reducible to highest-probability text prediction.

## How This Changes The Scientific Framing

Before integrating this paper, the project question was:

```text
Which model generates the best clinical handoff summary?
```

After integrating the paper, the better question is:

```text
Which model-plus-integration configuration best supports safe, source-grounded clinician handoff review under realistic human-AI collaboration constraints?
```

This is stronger scientifically because it does not pretend the model is acting alone. It evaluates the model in the workflow where it would actually be used.

## How This Changes The Product Framing

The product should be presented as:

```text
HandoffLens helps clinicians review discharge summaries by transforming long notes into source-grounded draft handoffs, highlighting changes, uncertainty, and safety items for verification.
```

The product should not be presented as:

```text
HandoffLens automatically determines the correct follow-up care plan.
```

## Proposed Write-Up Language

> We frame HandoffLens as an interpretive analytical human-AI decision-support system. The AI system performs high-throughput extraction and synthesis over long de-identified discharge summaries, while the clinician retains authority over verification, prioritization, and clinical judgment. This framing follows Li and Tian's conceptualization of AI-human collaborative decision-making as a redistribution of bounded rationality across human and algorithmic agents. In this use case, the model can reduce information-processing burden, but it can also introduce new AI-bounded risks such as unsupported claims, omitted safety issues, schema failures, or empty summaries. Therefore, our evaluation measures not only summary quality, but also source-record match, handover safety, contestability, and failure modes relevant to calibrated clinician trust.

## Practical Consequences For The Current Experiment

- Do not rank models only by fluency.
- Do not rank models only by API completion rate.
- Report whether the output is reviewable and contestable.
- Treat empty summaries as workflow failures.
- Treat summary-only repair separately from full structured extraction.
- Use the LLM-as-judge result as a support tool, not as the final clinical truth.
- Add clinician review before making strong claims about clinical utility.
