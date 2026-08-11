# Live-Retry Recovery Results

Experiment ID: `span-id-retry-recovery-v1`
Pre-registration: `docs/preregistration-retry-experiment.md`
Run: 2026-08-10, 20 frozen hard cases, both providers, `temperature = 0`, 1 repeat.
Aggregates only; raw per-case outputs remain private and uncommitted.

Design: first call = control `span_id_v5` (array, can over-emit). For cases with
any item exceeding 3 `evidence_span_ids`, a corrective retry feeds the model's own
output back with a fix instruction. The only manipulated variable is the retry.

## Result -- high recovery, content preserved (repeats=3)

A first run at repeats=1 showed 100% recovery for both providers (Cohere 51/51,
Haiku 225/225). A repeats=3 stability run corrected that optimistic sample: Haiku
holds at 100%, but Command A+ recovers ~79%, not 100%. Reported figures below are
the repeats=3 (robust) numbers.

| Provider | Violating items before -> after | Recovery rate [95%] | Mean paired Delta supported/case | Mean paired Delta items/case |
| --- | ---: | ---: | ---: | ---: |
| Cohere Command A+ | 189 -> 40 | 149/189, **78.8% [72.5, 84.1]** | -0.056 | -0.056 |
| Claude Haiku 4.5 | 350 -> 0 | 350/350, 100% [98.9, 100] | 0 | 0 |

A single corrective retry removes most too-many-span violations while preserving
item and supported-item counts (paired Delta ~= 0). But recovery is **not** complete
for Command A+: ~21% of violations persist after one retry, so a production loop
must not assume one retry always yields a compliant output -- fall back to
deterministic cap repair for the residual. Haiku fully recovered on this slice.

## Interpretation

The over-emission is **largely** a recoverable contract-following failure: shown
its own output and asked to comply, the model trims spans and keeps its content
(unlike the generation-time constraints, which dropped supported items). But the
recovery is partial for Command A+ (~79%), so a single retry is not a guarantee --
a residual fraction still violates and needs deterministic cap repair. Retry
reduces the repair burden; it does not eliminate it.

## Where this sits among the levers

| Lever | <=3 enforced? | Accepted? | Supported coverage | Cost |
| --- | --- | --- | --- | --- |
| Schema `maxItems` | -- | no (HTTP 400) | -- | -- |
| Prompt cap | yes | yes | drops supported items | none |
| Named slots | yes (by construction) | yes | drops supported items | none |
| Live retry | mostly (Cohere ~79%, Haiku 100%) | yes | preserved (Delta ~= 0) | one extra call per violating case; residual needs cap repair |
| Deterministic cap repair | yes (post-hoc) | n/a | preserved | none (deterministic) |

Two levers preserve coverage, and both act *after* free-form generation:
deterministic cap repair (free, deterministic truncation to the minimal span set)
and live retry (one extra round-trip, but the model re-selects which three spans
to keep). Recommendation: deterministic cap repair as the primary production lever
(no added latency or tokens); live retry as an option when model-chosen span
selection is preferred over deterministic truncation.

## Claim boundary and caveats

Contract-following recovery on a hard slice; 1 repeat. "Supported" is a
provenance-support proxy (span IDs resolve + `support_status == supported`), not
adjudicated gold recall, so "coverage preserved" means the auditable supported set
is preserved, not that semantic recall is proven. Retry latency/cost was not
optimized here; production use should bound retries (e.g. one attempt, then
deterministic repair).
