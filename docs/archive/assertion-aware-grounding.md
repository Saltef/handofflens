# Assertion-aware grounding check

Status: implemented as a deterministic proxy check, not clinical validation.

## Why this exists

Exact source containment is necessary for HandoffLens, but it is not sufficient for clinical grounding. A quote can be an exact substring and still not support the extracted meaning if the surrounding source says the finding is absent, possible, conditional, hypothetical, historical, or about someone else.

Example:

```text
No evidence of pulmonary embolism on CTA.
```

An extracted label of `pulmonary embolism` has lexical provenance, but the source assertion is absent. The audit should flag that as a possible assertion-status conflict.

## What changed

`scripts/clinical-validation-signals.js` now includes an assertion-status context check. For each evidence item, the audit:

1. locates the item quote in the source text when available;
2. takes a local context window;
3. narrows the context to the matching line or sentence;
4. classifies lightweight assertion status as one of:

```text
present
absent
possible
conditional
hypothetical
historical
associated_with_someone_else
```

If the label does not acknowledge a non-present assertion status, the semantic audit emits:

```text
possible_assertion_status_conflict
```

The candidate-first v4 source-fidelity audit now passes record-level source text into this check when the input result file includes it.

## What this proves

This improves the automated proxy audit by catching a known failure mode of lexical provenance: trimmed spans around negation or other assertion cues.

The regression test covers:

- `No evidence of pulmonary embolism` -> absent;
- `Possible pneumonia` -> possible;
- `Return for chest pain if symptoms recur` -> conditional;
- `History of atrial fibrillation` -> historical;
- `Family history of colon cancer` -> associated with someone else;
- an uncomplicated present finding.

## What this does not prove

This is not a full assertion-status model and does not establish clinical correctness. It is a scoped heuristic in the tradition of NegEx, ConText, and the i2b2/VA assertion-status task. It can miss long-distance negation, section-level assertion cues, abbreviation-heavy evidence, and complex temporal relationships.

The next stronger version should compare this deterministic proxy against human factual review and, if licensing permits, an assertion-status benchmark or a ConText-style baseline. Until then, lexical-overstatement rates are detector-dependent proxy diagnostics, not clinical findings.

Relevant grounding:

- Chapman et al. 2001, NegEx, Journal of Biomedical Informatics.
- Harkema et al. 2009, ConText, Journal of Biomedical Informatics.
- Uzuner et al. 2011, i2b2/VA assertion classification, Journal of the American Medical Informatics Association.
- Zha et al. 2023, AlignScore, ACL.
- Tang et al. 2024, MiniCheck, EMNLP.

## Lexical provenance overstatement metric

The helper script `scripts/analyze-lexical-overstatement.js` summarizes the same issue at run level:

```bash
npm run lexical:overstatement -- --input results/candidate-first-v4-final20-20260623/combined.json
```

It reports:

- total evidence items;
- evidence items whose quote is found in the source;
- lexically located items with non-present assertion context;
- status/domain breakdowns;
- `lexical_overstatement_rate`.

This metric is intended to quantify where lexical provenance may overstate semantic support. It remains an automated proxy; adjudicated labels are still required for precision, recall, and clinical claims.

## Typed provenance

The project also includes a typed-provenance classifier:

```bash
npm run typed:provenance -- --input results/candidate-first-v4-final20-20260623/combined.json
```

It classifies each evidence item as:

```text
direct_quote
normalized
inferential
unsupported
assertion_conflict
```

This is the practical answer to the main methodological critique: not every source-supported label is supported in the same way. Exact copied text, abbreviation expansion, standard normalization, inference from a quote, and assertion-status conflict should be counted separately.
