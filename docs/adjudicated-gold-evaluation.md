# Adjudicated gold-set evaluation

Status: tooling implemented; completed human labels are not included in the public artifact.

## Why this exists

Candidate-first v4 produced more evidence items than earlier pipelines. That creates the key unresolved question:

```text
Did v4 recover real evidence, or did it over-extract?
```

Gate-pass rate cannot answer that question. A deterministic provenance gate can estimate whether predicted items have lexical/source support, but it has no recall denominator. Item-level precision and recall require a small adjudicated gold item list.

## Gold-set format

Use `eval/adjudicated_gold_template.json` as the public shape. A private completed file should live under ignored local paths such as:

```text
results/adjudicated-gold-50-private.json
```

Each case contains explicit adjudicated targets:

```json
{
  "case_id": "case-id",
  "gold_items": [
    {
      "item_id": "case-id:G001",
      "domain": "diagnosis",
      "label": "acute kidney injury",
      "source_quote": "Acute kidney injury improved before discharge.",
      "assertion_status": "present"
    }
  ]
}
```

Recommended domains:

```text
medication
diagnosis
procedure_or_test
lab
follow_up
safety
other
```

## Analyzer

Run:

```bash
npm run adjudication:analyze -- --gold results/adjudicated-gold-50-private.json --predictions results/candidate-first-v4-final20-20260623/combined.json --out results/adjudicated-v4-analysis.json
```

The analyzer flattens v4-style extraction outputs and reports:

- item-level true positives;
- false positives;
- false negatives;
- precision;
- recall;
- F1;
- Wilson confidence intervals for precision and recall;
- domain-level breakdowns.

## Claims boundary

Allowed claim after a completed adjudicated set:

```text
On this adjudicated item-level source-fidelity set, candidate-first v4 had measured precision/recall for explicit reviewed targets.
```

Prohibited interpretations:

- clinical safety;
- autonomous use;
- external hospital generalization;
- patient-outcome improvement;
- prevalence estimates from a risk-enriched sample.

Use a probability-sampled independent set if the result is meant to estimate population rates.

