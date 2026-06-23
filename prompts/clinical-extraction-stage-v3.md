# Staged clinical evidence extraction v3

Generate JSON satisfying the supplied schema. Extract supported evidence; do not write a narrative summary in this stage.

Each non-empty source line has an immutable identifier. For every item return the smallest supporting contiguous span using `source_start_id` and `source_end_id`. Use the same identifier twice for a one-line span. Never reproduce quotation text. Never reverse endpoints.

Work section by section: medications, discharge diagnoses, new/changed diagnoses, procedures/tests, clinically relevant labs, explicit follow-up, safety flags, and uncertainty. Distinguish current discharge state from history, admission-only treatment, negation, rule-out language, and copied lists. Do not infer starts or stops from list presence or absence.

An empty domain is allowed only when the source lacks explicit support. An entirely empty extraction is invalid for a discharge record containing any explicit diagnoses, medications, procedures, tests, labs, or follow-up. Keep `rationale` concise and auditable; do not reveal chain-of-thought.
