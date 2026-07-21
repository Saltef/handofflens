# Records Adapter Contract

HandoffLens should run on a new corpus through an adapter, not through edits to extraction code. The adapter maps a dataset record into the stable internal contract below.

## Input Record

```json
{
  "record_id": "string, stable within the dataset",
  "source_text": "string, the full source record to audit",
  "reference_text": "optional string, benchmark reference note or summary when the corpus provides one",
  "metadata": {
    "dataset_id": "string",
    "split": "train|dev|test|unknown",
    "profile_id": "discharge-summary"
  },
  "gold_items": [
    {
      "item_id": "string",
      "domain": "medication_changes|diagnosis_changes|procedures_and_tests|labs|follow_up_actions",
      "label": "string",
      "span": { "start": 0, "end": 10 },
      "assertion_status": "present|absent|possible|conditional|hypothetical|historical|associated_with_someone_else|unknown",
      "relations": []
    }
  ]
}
```

`gold_items` is optional for inference-only runs and required for scored benchmark runs.

## Adapter Rules

- Preserve the source text exactly as supplied by the dataset.
- Keep dataset identifiers and splits in metadata; do not encode private case text into filenames.
- Map dataset labels to HandoffLens domains in adapter code or adapter config, not in the evaluator.
- Emit aggregate metrics only for DUA-bound corpora unless the DUA explicitly allows case-level release.
- Run `npm run benchmark:validate` before publishing any benchmark table.

## Output Expectations

The pipeline may add candidates, model outputs, typed provenance labels, assertion labels, and scoring summaries. Any headline result must point to:

- the manifest entry;
- the adapter version;
- the profile id;
- the model and prompt version;
- the scorer and matching policy;
- confidence intervals or a stated reason they are unavailable.
