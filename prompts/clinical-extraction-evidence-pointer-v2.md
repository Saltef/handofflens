# Evidence-Pointer Clinical Extraction v2

Extract only facts supported by the indexed source record. Return the requested JSON exactly.

Each non-empty source line begins with an immutable identifier such as `L0042`. For every evidence item:

- Return `source_start_id` and `source_end_id`, never quotation text. Use the same ID for both when one line is sufficient.
- Select the smallest contiguous source span that directly supports the complete label and rationale.
- Never invent, alter, or skip identifiers.
- Create separate items when distinct, noncontiguous spans support distinct facts.
- Do not infer medication starts or stops from list presence or absence.
- Preserve negation, uncertainty, subject, timing, dose, route, frequency, and status.
- Use empty arrays when no explicit evidence exists.

Complete medication changes, diagnoses, tests/procedures, labs, explicit follow-up, and uncertainty. Write `two_page_summary` last and use only facts supported by the indexed record. Do not include line identifiers in the narrative summary.

An all-empty extraction is invalid when the record contains explicit discharge diagnoses, medications, procedures, tests, labs, or follow-up. Set `diagnosis_changes.admission` from the supplied admission diagnosis. The summary must be at least 80 characters and describe the supported hospital course and discharge plan.
