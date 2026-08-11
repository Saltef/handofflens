# Pre-Registration: End-to-End Cardinality-Constraint Experiment

Timestamp: 2026-08-10, written before any live provider call for this experiment.
Experiment ID: `structured-output-maxitems-causal-v1`.
Unit: provider run (one model / arm / case / repeat) and extracted evidence item.

## Motivation

The frozen span-ID-v5 ablation (see `docs/claims-register.md`, Phase 4) showed a
provider-specific span-ID result that depended on the hosted structured-output
compatibility layer. That layer strips local JSON Schema cardinality/format
keywords before submission (`maxItems`, `minItems`, `minLength`, `maxLength`,
`minimum`, `maximum`, `pattern`, `uniqueItems`) while preserving `enum`. The
offline guard `scripts/test-structured-output-constraints.js` pins that behavior.

Consequence in the frozen run: span IDs resolved 100% (enum kept), but the local
3-span evidence cap was not enforced at generation time (`maxItems` stripped),
producing 703 Haiku and 130 Cohere too-many-span violations that were only fixed
by deterministic post-hoc cap repair.

Open question this experiment answers causally: **does retaining `maxItems` in the
submitted schema cause each provider to stop over-emitting spans at generation
time?** This is the difference between a real model-quality issue and a schema
transport artifact.

## Design (one manipulated variable)

Paired within-case A/B on the same frozen 20 hard cases (verified by
`cases_sha256`), same model, same prompt, `temperature = 0`, `span_id_v5` arm,
`R` repeats per cell.

| Arm | Submitted schema | Prompt | Difference vs control |
| --- | --- | --- | --- |
| Control | strip all 8 unsupported keywords (current behavior) | current system prompt | baseline |
| Treatment | strip the other 7, **retain `maxItems`** | current system prompt | `maxItems` present in schema |
| Prompt-cap | strip all 8 (same as control) | current system prompt **+ "emit at most 3 evidence_span_ids per item"** | one appended instruction |

Each arm changes exactly one variable versus control: Treatment changes the
submitted schema; Prompt-cap changes the instruction. Everything else (cases,
temperature, span index, enum contract) is held fixed.

Amendment (2026-08-10, after the Treatment smoke): the live smoke returned a
deterministic HTTP 400 on both providers for the Treatment arm
(`maxItems` not supported on `array` type), i.e. the pre-registered **Rejects**
outcome. Because schema rejection is provider-side and case-invariant, Treatment
is confirmed on a small set rather than the full 20 (running it 20x cannot change
a deterministic rejection). The Prompt-cap arm was added as the now-relevant lever
and is registered here before its full run.

Providers: Cohere Command A+ (`command-a-plus-05-2026`, `json_object` + `schema`
route) and Anthropic Claude Haiku 4.5 (OpenRouter `json_schema`, `strict: true`
route). The two routes differ, so the result is reported per provider, not pooled.

## Outcomes

Per arm, per provider:
1. **Request acceptance** — HTTP 2xx vs provider schema-rejection error.
2. **Too-many-span violation rate** — items with more than 3 `evidence_span_ids`
   (primary endpoint).
3. **Mean `evidence_span_ids` per item.**
4. **Raw item support rate** and **v5 contract validity rate** (secondary,
   scored with the existing `scoreAblationRecord` path).

Primary endpoint: too-many-span violation rate, control vs treatment, paired by
`(case, repeat)`, per provider, reported as an absolute difference with a
Wilson 95% interval.

## Pre-registered predictions

Each provider falls into exactly one of three outcomes:
- **Honors** — treatment accepted and violation rate drops to ~0. The cap is free
  at generation time; post-hoc repair becomes unnecessary. (Predicted most likely
  for the Cohere `json_object` route.)
- **Accepts but ignores** — treatment accepted, violation rate unchanged. Confirms
  the silent-drop failure mode end-to-end; the compat layer was right to strip it
  because keeping it changes nothing.
- **Rejects** — treatment returns a schema error. The route does not support
  cardinality constraints; the compat stripping is mandatory, and the cap must
  live in post-processing. (Considered plausible for the OpenRouter `strict`
  `json_schema` route.)

Directional prior: at least one provider will differ from the other, because the
frozen ablation already showed the two routes behave differently under the same
schema. A same-direction result on both providers would itself be reportable.

Prompt-cap predictions (registered before its full run):
- Primary endpoint: too-many-span violation rate, prompt-cap vs control, paired by
  `(case, repeat)`, per provider, absolute difference with Wilson 95%.
- Directional prediction: the appended instruction reduces the violation rate
  relative to control on at least one provider. A null or negative effect is
  equally reportable — it would show the models do not reliably self-limit span
  emission from instruction alone, so deterministic cap repair remains necessary.
- Secondary: check that item count and raw item support do not collapse under the
  instruction (i.e. the cap does not simply suppress extraction).

## Decision rule

- If a provider **honors** `maxItems`: recommend moving the cap into the submitted
  schema for that route and drop the corresponding cap-repair step; re-measure raw
  (non-repaired) support as the new baseline.
- If **accepts but ignores** or **rejects**: keep post-hoc cap repair, and report
  to Cohere that the constraint does not survive that route — a concrete
  structured-output request, not a model-capability claim.

## Claim boundary

This experiment manipulates the submission contract only. It tests whether a
provider honors a cardinality constraint end to end. It is **not** evidence of
semantic entailment, clinical correctness, target recall, or model superiority.
Span-ID resolvability remains true by construction (the enum is kept in both
arms).
