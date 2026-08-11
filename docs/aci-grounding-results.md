# Real-Data Grounding Pass — Command A+ Judge on ACI-Bench Notes

Experiment ID: `aci-grounding-judge-v1`
Run: 2026-08-11. 25 real ACI-Bench records (public, CC BY 4.0). The Command A+
grounding judge scored each expert-note sentence for support by the source
conversation. Aggregates only; raw outputs local/uncommitted.

Purpose: put the grounding judge (perfect on the synthetic bake-off) onto real
clinical text. ACI has no per-sentence grounding gold, so this is a DESCRIPTIVE
behavior pass — flag rate plus inspectable examples — not validated accuracy.

## Result

- 1,068 note sentences scored; median support 0.95, p25 0.90, p75 1.00. The judge
  scores the large majority of real note sentences as well-grounded.
- All-sentence flag rate (support < 0.5): 185/1,068 = 17.3%.
- After removing section headers (e.g. "CHIEF COMPLAINT", "ASSESSMENT AND PLAN",
  which are not claims and correctly score 0): **claim-level flag rate 123/959 =
  12.8%**.

## What the flags are (manual inspection)

The flagged claim sentences are a mix:
- **Genuine grounding gaps** — historical or comparative details a discharge note
  carries that the source conversation does not state, e.g. "colonoscopy about 3
  years ago", "echocardiogram appears unchanged in comparison to last year".
- **Negated findings** — "Denies anxiety", "Denies chest pain": the judge is
  strict about scoring negations as source-supported facts.
- **Residual parsing artifacts** — sub-section labels ("Gastrointestinal") and a
  sentence-splitter error ("Deniesswelling") that a cleaner segmenter would drop.

## Interpretation

On real clinical notes the Command A+ grounding judge behaves sensibly: it
affirms most sentences and concentrates its low scores on synthesized,
historical, and comparative content that a strict source-grounding check should
question. The 12.8% figure is a descriptive flag rate, not an error rate — some
flags are legitimate grounding gaps, some are judge strictness, and some are
segmentation noise. A production use would add a claim/segment filter and, for a
real accuracy number, human adjudication of a flagged sample.

## Structured-output note observed during this run

The judge initially failed with HTTP 422 `INVALID_TOOL_GENERATION` whenever
`thinking: { type: "disabled" }` was combined with a long transcript input
(the short synthetic bake-off pairs were unaffected). Switching to an enabled
thinking budget with output headroom resolved it. This is reported as
structured-output feedback, not a capability claim.

## Claim boundary

Descriptive verifier behavior on 25 real ACI expert notes; no per-sentence
grounding gold; expert notes contain legitimate synthesis so a subset of flags
are inference rather than error. Not validated accuracy, not clinical
correctness, not population performance.
