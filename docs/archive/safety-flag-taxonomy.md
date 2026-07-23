# Safety Flag Taxonomy

`safety_flags` is intentionally narrower than general clinical risk.

The field captures source-stated items a receiving clinician should not miss during follow-up review. It should not capture broad inferred themes that are clinically plausible but not explicitly stated by the discharge summary.

## Safety Types

Each safety flag must include `safety_type`.

| Type | Use for | Do not use for |
| --- | --- | --- |
| `return_precaution` | Explicit return, call, seek-care, or escalation triggers. | Generic risk labels such as "infection monitoring". |
| `monitoring_instruction` | Explicit lab checks, measurements, logs, symptom tracking, or monitoring tasks. | Broad inferred monitoring needs without a source-stated test, target, or action. |
| `medication_safety` | Explicit high-risk medication instructions, dose/hold/stop warnings, toxicity, bleeding, renal dosing, or interaction concerns. | Routine medication starts or stops that belong in `medication_changes`. |
| `pending_or_critical_result` | Pending tests, critical results, abnormal results needing named follow-up. | Completed normal tests without follow-up implications. |
| `source_stated_risk` | Other source-stated risk or contingency item that does not fit above. | Model-inferred clinical worries. |

## Atomicity Rule

Prefer atomic items.

If the source says:

```text
Return promptly for fever, spreading redness, increasing drainage, or severe pain.
```

Extract:

```text
fever
spreading redness
increasing drainage
severe pain
```

Do not extract:

```text
Wound monitoring for signs of infection
```

## Trade-Off

This taxonomy will reduce vague false positives and make omission analysis cleaner. It may lower recall for implicit but clinically reasonable risks. That is acceptable for the public HandoffLens task because the project is measuring source-grounded extraction, not autonomous clinical risk discovery.

## Type-Aware Scoring

Safety scoring requires both a label match and a `safety_type` match when the reference item specifies a type.

This means:

- `fever` as `return_precaution` can match `Return promptly for fever`;
- `monitor potassium and creatinine` must be extracted as `monitoring_instruction`;
- a correct label with the wrong type is counted as a type error, not a true positive;
- omitted safety subtypes are reported separately.

The trade-off is stricter scoring. A model may receive a lower safety score even when it extracted a clinically related phrase. That is intentional: the purpose is to separate return precautions from monitoring instructions and other safety-relevant follow-up work.
