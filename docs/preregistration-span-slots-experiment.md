# Pre-Registration: Named-Slot Span Schema (Design-Around)

Timestamp: 2026-08-10, written before any live provider call for this experiment.
Experiment ID: `span-slots-design-around-v1`.
Unit: extracted evidence item, case, provider run.

## Motivation

`structured-output-maxitems-causal-v1` established that the array cap
`evidence_span_ids: {maxItems: 3}` cannot be enforced end to end: both providers
reject `maxItems` on arrays, so models over-emit spans and output must be
repaired; a prompt cap reduces violations only by dropping supported items.

The compat layer preserves `enum`. This experiment tests a schema redesign that
uses only `enum`: replace the array with three optional named fields
`evidence_span_1`, `evidence_span_2`, `evidence_span_3`, each `{type: string,
enum: <span index ids>}`. "At most 3" then holds by construction (three fields),
and the model is not told to extract fewer items — only to distribute up to three
span IDs across named fields.

## Design (arms)

Same frozen 20 hard cases, same model, same prompt base, `temperature = 0`, per
provider.

| Arm | Span representation | Bound mechanism |
| --- | --- | --- |
| array_control | `evidence_span_ids` array (compat-stripped) | none end to end (can over-emit) |
| slots | three named enum fields | <=3 by construction |

## Outcomes (per provider, paired by case)

1. **Acceptance** — does the slots schema submit without a provider 400?
2. **Too-many-span rate** — expected 0 for slots by construction; measured to
   confirm the model cannot exceed three named fields.
3. **Item count** — should stay comparable to array_control (recall preserved).
4. **Supported items** — span IDs resolve in the frozen index and
   `support_status == supported`; should not drop relative to array_control.

## Pre-registered predictions

- The slots schema is accepted by both providers (only `enum` is used; no
  cardinality keyword). If a provider rejects it, that is itself reportable.
- Too-many-span rate is 0 for slots by construction.
- Item count and supported-item count are within noise of array_control (the key
  claim: unlike the prompt cap, the structural bound does not cost coverage).
- If instead item/support counts drop under slots, the named-field format itself
  degrades extraction and the design-around is not free.

## Decision rule

- If slots is accepted, yields 0 violations, and preserves item/support counts:
  recommend the named-slot schema as the primary provenance representation — it
  removes the need for both `maxItems` and post-hoc cap repair without recall loss.
- If slots preserves compliance but reduces items/support, or is rejected: fall
  back to deterministic cap repair (still the safe primary lever).

## Claim boundary

Schema-shape manipulation only. Tests whether a named-enum-slot representation is
accepted and bounds span count by construction while preserving auditable support.
Not semantic entailment, clinical correctness, target recall, or model
superiority. "Supported" is a provenance-support proxy, not adjudicated gold.
