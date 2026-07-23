# Evidence pipeline v3 - final development report

Public-facing note: this report documents a rejected intermediate architecture. It is included because negative engineering results are useful: more stages, recovery calls, and verifier passes did not automatically improve reliability.

## Decision

V3 was not promoted because it did not improve reliability enough to justify its complexity or cost. Evidence-span v2 remained the simpler conservative comparator, and candidate-first v4 became the stronger follow-on architecture.

The v3 pipeline successfully adds auditable hidden reasoning, section signals, weak-completeness checks, bounded span repair/rejection, preserved failure telemetry, independent extraction, automated entailment verification, targeted recovery, evidence-only summaries, explicit abstention, and stability measurement. It does not improve reliability enough to justify its complexity or cost.

## Architecture

1. Deterministic section signals preserve recall and never delete source text.
2. The configured instruction model performs full-schema span extraction with hidden reasoning budget 512; chain-of-thought is not requested or stored.
3. Unknown/oversized spans are rejected per item; short reversed spans are repaired with an audit event.
4. One targeted recovery is allowed for signaled but empty domains.
5. A differently ordered independent extraction supplies agreement measurement and high-recall candidates.
6. A blinded same-family verifier classifies span-label entailment.
7. Only verifier-supported evidence is eligible for narrative summary generation.
8. Deterministic provenance, vacuity, consistency, summary-number, and abstention gates run last.

## Definitive five-case development pilot

- Final deterministic gate pass: 3/5.
- Recovery triggered: 5/5.
- Median independent exact-item Jaccard: 0.045.
- Verifier decisions: 103 supported, 4 uncertain, 2 unsupported.
- Calls: 25 (five per case).
- Recorded tokens: 101,648 input and 25,442 output.
- Sum of recorded API latency: 88.9 seconds.

The simple evidence-span v2 candidate previously passed 14/20 development cases using one extraction call per case. These samples are not directly comparable as unbiased estimates, but v3's 3/5 pass rate, universal recovery dependence, very low agreement, and fivefold call count provide no engineering justification for promotion.

## Stability study (two development cases)

- Identical repeat: mean accepted-label Jaccard 0.483; neither case was an exact match.
- Whitespace normalization: mean Jaccard 0.045.
- Rewrapping: mean Jaccard 0.700, driven partly by one case being empty in both runs.
- One case changed from zero to 17 accepted items across nominally identical runs.
- Gate yield varied from 1/2 to 2/2 across conditions.

The stability experiment used 39 calls, 190,449 input tokens, and 44,344 output tokens. With only two cases these are diagnostic observations, not population estimates, but they are sufficiently poor to trigger the stop rule.

## What automated checks can and cannot establish

The implemented checks can establish schema validity, source provenance, span bounds, exact numeric traceability, some negation/status conflicts, repeatability, same-family judge agreement, and explicit withholding of vacuous outputs.

They cannot establish clinical correctness, clinical importance, omission severity, safe follow-up, or generalizability. The automated verifier is a same-family proxy diagnostic and has not been independently calibrated against humans.

## Research interpretation

The literature supports deterministic postprocessing and selective second-pass auditing, but does not imply that adding more model stages always helps. In this experiment, second passes exposed instability and sometimes recovered omissions, while also multiplying cost and producing highly variable candidate sets. The result favors a conservative selective architecture: one evidence-span extraction, deterministic gating, and targeted recovery or verification only for explicitly triggered failures.

## Design lesson carried forward

- Primary: evidence-span v2, hidden reasoning 512, full schema, temperature 0.
- Reject vacuous, unknown, and oversized-span outputs.
- Permit one recorded short-span endpoint repair.
- Trigger recovery only for failed/signaled domains.
- Trigger verifier only for recovery outputs, deterministic semantic conflicts, or low cross-pass confidence, not every item.
- Withhold rather than summarize when no evidence survives.
- Treat larger runs as protocol-bound evaluations only after automated development behavior is stable and the evaluation protocol is frozen.

Research basis: [Mahbub et al. 2026](https://arxiv.org/abs/2604.06028), [Karim and Uzuner 2026](https://arxiv.org/abs/2605.15467), [CeRTS 2025](https://doi.org/10.1016/j.jbi.2025.104900), [Cohere reasoning](https://docs.cohere.com/docs/reasoning), and [Cohere structured outputs](https://docs.cohere.com/docs/structured-outputs).

