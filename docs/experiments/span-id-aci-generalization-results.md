# Span-ID Interface -- Generalization to Real ACI Notes

Experiment ID: `span-id-v5-ablation` on 20 real ACI-Bench records (public, CC BY
4.0), arms quote_v2 vs span_id_v5, both providers, 2 repeats. Run 2026-08-11.
This is the generalization test for the hard-slice flagship: do the span-ID
effects hold on representative real notes that were NOT selected for difficulty?

## Item support by arm

Command A+ ran the full **n=67** (all clean local ACI records, 2 repeats, 134
runs/arm). The Haiku n=67 arm is **partial**: the OpenRouter key exhausted its
credit (HTTP 402) ~58 runs in, so only ~57% of Haiku runs completed (824/855
items across ~29 effective cases). The earlier full n=20 Haiku run is shown
alongside; both point the same way.

| Model | n | quote-v2 | span-ID-v5 | v5 contract validity |
| --- | ---: | ---: | ---: | ---: |
| Command A+ | 67 (full) | 65.9% [64, 68] | 91.5% [90, 93] | 82.3% |
| Claude Haiku 4.5 | 67 (partial, ~57% runs) | 58.6% [55, 62] | 82.3% [80, 85] | 59.5% |
| Claude Haiku 4.5 | 20 (full) | 46.8% [42, 51] | 87.2% [84, 90] | 64.4% |

Comparison to the hard-20 slice:

| Model | hard-20 quote-v2 -> span-ID | real ACI quote-v2 -> span-ID |
| --- | --- | --- |
| Command A+ | 64.5% -> 88.3% (n=20) | 65.9% -> 91.5% (n=67) |
| Haiku 4.5 | 93.6% -> 67.0% (degraded, n=20) | 46.8% -> 87.2% (n=20); 58.6% -> 82.3% (n=67 partial) |

## Two findings

1. **Command A+'s span-ID benefit replicates on real data, at n=67.** The gain
   (65.9% -> 91.5%, tight CIs on 67 real notes) matches and slightly exceeds the
   hard-slice gain (64.5% -> 88.3%), and the case gate rose from 23% (n=20) to 53%
   (n=67). The constrained-pointer benefit for Command A+ is not an artifact of
   the difficulty-selected slice or of small n; it holds and strengthens on a
   representative real-note sample.

2. **The cross-provider divergence does NOT generalize.** On the hard slice, span
   IDs *hurt* Haiku (93.6% -> 67.0%); on real ACI, span IDs *helped* Haiku at both
   n=20 (46.8% -> 87.2%) and the partial n=67 (58.6% -> 82.3%). So the earlier
   "span IDs help Command A+ but hurt Haiku" pattern was hard-slice-specific, not
   a general provider property. On real ACI both providers improve with the
   constrained interface.

## Correction to the earlier framing

The pre-registered cross-provider prediction was "the span-ID gain should hold
across both providers; if it does not, the provider interaction is itself the
result." On the hard slice it did not hold (divergence). On real ACI it does hold
(both improve). The honest synthesis: **the span-ID gain is robust for Command A+
across both the hard slice and real notes; the Haiku hard-slice degradation was
slice-specific and reversed on real data.** Any report must scope the divergence
to the hard slice and must not present "span IDs hurt Haiku" as general.

## Claim boundary

Item-level lexical/span support on 20 real ACI notes, 2 repeats; not semantic
entailment, target recall, clinical correctness, or a leaderboard. Case gates are
low (conjunctive, item-count sensitive) and item support is the primary metric.
Span-ID resolvability is by construction; v5 contract validity is reported
separately (Command A+ 81.4%, Haiku 64.4%).
