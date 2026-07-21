# Validation roadmap

This roadmap describes the remaining work in public-facing terms. It is not a list of defects; it is the boundary between engineering evidence and stronger scientific or clinical claims.

## Next factual-review milestone

The immediate next step is non-clinician factual review of the prepared packets:

- source quote supports the label;
- quote is complete enough for the claim;
- category is consistent with the displayed evidence;
- transformation is verbatim, explicitly equivalent, standard interpretation, unsupported, or unclear;
- duplicate or redundant evidence is identified.

This review can answer whether candidate-first v4's higher item count reflects recovered evidence, over-extraction, or both.

## Next engineering milestone

After factual review, the system can be refined around the observed failure modes:

- negation conflicts;
- incomplete or over-broad quotes;
- medication timing and status ambiguity;
- summary leakage;
- abstention thresholds;
- duplicate evidence.

The goal is not to maximize yield blindly. The goal is to improve source fidelity while making review burden explicit.

## Next statistical milestone

If stronger estimates are needed, the next design should use independent source-fidelity labels and report paired case-level endpoints with intervals. Atomic extracted items should not be treated as independent patient-level observations.

## Next clinical milestone

Clinical claims require qualified clinical review. Factual source support is not the same as clinical importance, harmfulness, appropriateness, or safety.

## Currently unavailable

- Temporal validation: source cases do not contain usable real dates/times.
- External validation: no independent external cohort is available.
- Completed clinician annotation: not available in the current artifact.

These limitations are part of the study design and data situation. They should remain visible in any public presentation.
