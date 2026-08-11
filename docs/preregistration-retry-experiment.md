# Pre-Registration: Live-Retry Recovery of Contract-Invalid Span-ID Items

Timestamp: 2026-08-10, written before any live provider call for this experiment.
Experiment ID: `span-id-retry-recovery-v1`.
Unit: extracted evidence item, and case.

## Motivation

The frozen span-ID-v5 ablation and the `structured-output-maxitems-causal-v1`
experiment established that the 3-span cap cannot be enforced in the submitted
schema (both providers reject `maxItems`), so models over-emit spans and the
output must be repaired. `docs/claims-register.md` lists as remaining work:
"test live provider retry prompts for contract-invalid items ... to separate
recoverable contract-following failures from cases needing reranking or semantic
entailment checks."

Open question: when a model produces a contract-invalid item (more than 3
`evidence_span_ids`), does a single live corrective retry recover it to a valid
AND still-supported item? If yes, the failure was contract-following (cheap to
fix with a retry). If no, it needs deterministic repair or deeper reranking.

## Design (one manipulated variable: retry)

Same frozen 20 hard cases, same model, same prompt, `span_id_v5` arm,
`temperature = 0`, per provider.

1. First call (identical to control): model emits items; count violations
   (items with > 3 `evidence_span_ids`).
2. If a case has zero violating items, retry is not applicable and the case is
   recorded as `no_retry_needed`.
3. Retry call (treatment): resend the original messages, append the model's own
   first response as an assistant turn, then a user turn:
   "Some items used more than 3 evidence_span_ids. Return the full JSON again with
   at most 3 evidence_span_ids per item, keeping only the most decisive spans. Do
   not add, drop, or change items otherwise." Same response schema.
4. Re-score the retry output: violations, item count, supported items (span IDs
   resolve in the frozen span index and `support_status == supported`).

The only manipulated variable is the presence of the corrective retry turn.

## Outcomes

Per provider, paired by case:
1. **Violation recovery** — violating items before vs after retry (primary).
2. **Supported-item preservation** — supported items before vs after (guards
   against the retry fixing the cap by deleting items, the failure mode seen in
   the prompt-cap experiment).
3. **Item-count stability** — total items before vs after (should stay ~equal if
   the retry only trims spans).

## Pre-registered predictions

- Retry will reduce the violating-item count on both providers (directional).
- The informative unknown is preservation: if supported items and item count
  stay roughly constant while violations fall, the failures were recoverable
  contract-following errors. If retry cuts violations by dropping supported items
  or items (as the prompt-cap did), then retry is not a clean fix and
  deterministic cap repair remains preferred.
- A provider difference is possible and is itself reportable (Haiku over-emitted
  far more at baseline, so it has more to recover).

## Decision rule

- If retry recovers violations while preserving supported items and item count on
  a provider: recommend a bounded live retry as a cheap first-line fix for that
  provider, with deterministic cap repair as the fallback.
- If retry preserves compliance only by dropping items/support: keep deterministic
  cap repair as primary and report retry as insufficient.

## Claim boundary

Contract-following recovery on a hard slice only. Tests whether a corrective retry
restores the local span-count contract while preserving auditable support. Not
semantic entailment, clinical correctness, target recall, or model superiority.
"Supported" is a provenance-support proxy, not adjudicated gold.
