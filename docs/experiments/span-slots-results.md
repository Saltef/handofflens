# Named-Slot Span Schema Results (Design-Around)

Experiment ID: `span-slots-design-around-v1`
Pre-registration: `docs/preregistration-span-slots-experiment.md`
Run: 2026-08-10, 20 frozen hard cases, both providers, `temperature = 0`, 1 repeat.
Aggregates only; raw per-case outputs remain private and uncommitted.

Arms: `array_control` (standard `evidence_span_ids` array, compat-stripped) vs
`slots` (three optional named enum fields `evidence_span_1/2/3`).

## Result -- the structural bound works, but it also costs supported coverage

| Provider | Arm | Accepted | Items | Supported items | Too-many-span rate [95%] |
| --- | --- | ---: | ---: | ---: | ---: |
| Cohere Command A+ | array_control | 20/20 | 482 | 473 (98%) | 48/482, 10.0% [7.6, 13.0] |
| Cohere Command A+ | slots | 20/20 | 339 | 289 (85%) | 0/339, **0%** [0, 1.1] |
| Claude Haiku 4.5 | array_control | 20/20 | 701 | 690 (98%) | 227/701, 32.4% [29.0, 35.9] |
| Claude Haiku 4.5 | slots | 20/20 | 590 | 578 (98%) | 0/590, **0%** [0, 0.7] |

Paired `slots` vs `array_control`, per case:

| Provider | Delta item count [95%] | Delta supported items [95%] | Delta unsupported items [95%] |
| --- | ---: | ---: | ---: |
| Cohere Command A+ | -7.15 [-13.3, -1.0] | **-9.2 [-16.0, -2.4]** | +2.05 [-1.1, +5.2] |
| Claude Haiku 4.5 | -5.55 [-9.6, -1.5] | **-5.6 [-9.6, -1.6]** | +0.05 [-0.3, +0.4] |

## What worked and what did not

- **Accepted end to end**: yes, both providers. The named-enum-slot schema uses
  only `enum` (kept by the compat layer), so it passes where `maxItems` is
  rejected. This confirms the transport mechanism.
- **Bounds span count by construction**: yes, 0 violations on both providers,
  with no `maxItems` and no post-hoc repair. This part of the design-around is a
  clean success.
- **Preserves coverage**: **no.** Item count fell on both providers, and supported
  items fell with it (paired CIs exclude zero). On Cohere the support *rate* also
  dropped (98% -> 85%), i.e. the named-field format hurt Cohere's provenance
  quality, not just its item count. So the structural bound is not free: like the
  prompt cap, it reduces supported coverage.

## Decision -- do not constrain emission at generation time

Three interventions have now been tested against the same frozen slice:

| Lever | Enforces <=3? | Accepted? | Supported-coverage cost |
| --- | --- | --- | --- |
| Schema `maxItems` | -- | **no (HTTP 400)** | -- |
| Prompt cap | yes | yes | supported items dropped (recall loss) |
| Named slots | yes (by construction) | yes | supported items dropped (worse on Cohere) |
| Deterministic cap repair | yes (post-hoc) | n/a | preserves the full supported item set |

Every lever that changes what the model emits at generation time costs supported
coverage. The one lever that does not -- deterministic cap repair on the free-form
array output -- is therefore the recommended primary design: let the model extract
freely (maximizing supported items) and enforce the 3-span cap deterministically
afterward.

## Claim boundary and caveats

Schema-shape and instruction manipulation on a hard slice; 1 repeat. Supported is
a provenance-support proxy (span IDs resolve + `support_status == supported`), not
adjudicated gold recall. The direction (generation-time constraints reduce
supported coverage) is consistent across two providers and two interventions; a
repeats>=3 confirmation would tighten the magnitudes, and gold targets would
convert the supported-item proxy into a true recall measure.
