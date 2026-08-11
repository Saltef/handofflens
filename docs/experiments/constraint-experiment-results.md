# Constraint Experiment Results

Experiment ID: `structured-output-maxitems-causal-v1`
Pre-registration: `docs/preregistration-constraint-experiment.md`
Run: 2026-08-10, 20 frozen hard cases, both providers, `span_id_v5` arm,
`temperature = 0`, 1 repeat. Raw per-case outputs remain private and uncommitted;
only aggregates are recorded here.

Unit: extracted evidence item, and provider run. Endpoint: too-many-span
violation rate (items with more than 3 `evidence_span_ids`).

## Result 1 -- Schema-level cap is rejected by both providers (Treatment)

Retaining `maxItems` in the submitted schema produced a deterministic HTTP 400 on
**every** run, on both providers:

| Provider | Route | Treatment accepted | Error |
| --- | --- | ---: | --- |
| Cohere Command A+ | `json_object` + `schema` | 0/20 | `non-supported constraint for type: 'array'. constraint: 'maxItems'` |
| Claude Haiku 4.5 | OpenRouter `json_schema` `strict` | 0/20 | `For 'array' type, property 'maxItems' is not supported` |

This is the pre-registered **Rejects** outcome, and it fired on both providers.
The 3-span cap cannot be enforced end to end through the structured-output schema
on either route. The compatibility layer's stripping of `maxItems` is therefore
mandatory, not incidental. The cap must live in post-processing or in the prompt.

## Result 2 -- A prompt-level cap sharply reduces over-emission (Prompt-cap)

Appending one instruction ("emit at most 3 `evidence_span_ids` per item") to the
control prompt, with the control schema, caused a large paired reduction in the
violation rate on both providers:

| Provider | Control violation rate | Prompt-cap violation rate | Mean paired Delta (rate) [95%] |
| --- | ---: | ---: | ---: |
| Cohere Command A+ | 47/468, 10.0% [7.6, 13.1] | 4/252, 1.6% [0.6, 4.0] | -8.8 pp [-14.1, -3.4] |
| Claude Haiku 4.5 | 235/702, 33.5% [30.1, 37.0] | 6/551, 1.1% [0.5, 2.4] | -29.5 pp [-38.1, -20.9] |

Both paired intervals exclude zero. The effect is much larger on Haiku, which
over-emitted far more at baseline (33.5% vs Cohere 10.0%). This is a real,
causal, single-variable effect: the only change from control was the appended
instruction.

## Result 3 -- The prompt cap reduces violations by dropping SUPPORTED items (recall loss)

A second run (control + prompt-cap, capturing per-item provenance support) shows
the instruction both caps the per-item span tail **and** drops items -- and the
dropped items are almost entirely supported ones, not over-extraction.

| Provider | Span tail 4+ control -> cap | Items control -> cap | Supported-item rate both arms | Mean paired Delta supported items [95%] | Mean paired Delta unsupported items [95%] |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cohere Command A+ | 41 -> 5 | 430 -> 288 | 98.6% -> 97.6% | **-7.15 [-12.6, -1.7]** | +0.05 [-0.36, +0.46] |
| Claude Haiku 4.5 | 244 -> 4 | 724 -> 539 | 98.6% -> 98.9% | **-9.05 [-13.7, -4.4]** | -0.20 [-0.64, +0.24] |

The span-tail collapse is real (4+ spans/item -> ~0), so the instruction does cap
spans. But baseline unsupported extraction was already negligible (~98.6%
supported in both arms), so there was almost no over-extraction to shed. The
entire item drop lands on **supported** items (Delta supported ~= Delta total; Delta
unsupported ~= 0, interval spans zero on both providers). The violation-rate
improvement is therefore bought with coverage, not with cleaner selection.

Proxy caveat: "supported" here means the item's span IDs resolve in the frozen
span index and its self-reported `support_status` is `supported`. This is a
provenance-support proxy, not adjudicated gold recall. The direction is
unambiguous -- the cap does not remove unsupported items -- but the magnitude of
true recall loss needs gold targets to confirm.

## Interpretation and decision

- **Schema cap**: closed. Report to Cohere that `maxItems` (and, from the offline
  guard, other cardinality/format constraints) is rejected on the array type in
  structured output. This is a concrete structured-output request, not a
  model-capability claim.
- **Prompt cap**: causally eliminates too-many-span violations on both providers,
  but by dropping supported items, not by shedding over-extraction. It is **not**
  an extraction-quality improvement; it trades coverage for compliance and should
  not be shipped as one.
- **Deterministic cap repair remains the primary lever** because it enforces the
  3-span cap while preserving the supported item set. On this evidence the prompt
  cap is not even a good complement, because the models were barely
  over-extracting to begin with.

## Repeats=3 stability

A repeats=3 rerun reproduced the constraint findings: `maxItems` still rejected on
both providers (treatment 0/60 accepted); the prompt-cap paired violation-rate
drop held (Cohere Delta -0.091 [-0.136, -0.047], matching the earlier -0.073 to
-0.088); and the recall-loss pattern reproduced (Cohere items 1,231 -> 781 with
supported rate ~98% in both arms, i.e. the drop is supported items). Unlike the
retry experiment -- whose repeats=1 100% figure fell to ~79% for Command A+ under
repeats=3 -- the constraint conclusions are stable across repeats.

## Cluster-robust inference note

Items are nested in 20 cases and correlated within case. A case-level cluster
bootstrap (resample cases, 20k draws) confirms the paired causal deltas -- which
were already computed per case -- are essentially unchanged (e.g. Cohere Delta
supported/case bootstrap [-12.8, -1.6] vs normal-z [-12.6, -1.7]). The *per-arm
pooled* violation rates, however, were reported with item-level Wilson intervals
that ignore clustering and are too narrow; the cluster-robust versions are wider
(Cohere control 9.5% [4.6, 15.6] vs item-Wilson [7.1, 12.7]; Haiku control 33.7%
[25.3, 42.9] vs [30.4, 37.2]). No conclusion changes: recall loss stays
significantly negative and the violation reduction stays significant on both
providers. Read per-arm rates as cluster-robust; treat paired deltas as the
primary evidence.

## Claim boundary

Submission-contract and instruction manipulation on a hard slice. Tests whether a
provider honors a cardinality constraint and whether an instruction changes span
emission. Not semantic entailment, clinical correctness, target recall, or model
superiority. Span-ID resolvability remains true by construction in all accepted
arms.

## Next evidence step

Re-run prompt-cap vs control with a fixed item set (score span selection on the
same extracted items) or against adjudicated/reference targets, to separate
"selected fewer spans" from "extracted fewer items." Only then can the prompt cap
be compared to deterministic cap repair on a recall basis.
