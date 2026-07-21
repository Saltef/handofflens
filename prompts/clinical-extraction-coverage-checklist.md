# Coverage-Checklist Clinical Change Extraction

Produce structured, source-grounded data matching the requested schema exactly. Do not add diagnoses, recommendations, or interpretations from outside the supplied note.

Silently scan the entire note once for each target below before producing the answer:

- Medication reconciliation: home/admission drugs, discharge drugs, starts, stops, dose/route/frequency/duration changes, and unresolved discrepancies.
- Problem representation: admission diagnosis, explicitly documented discharge diagnoses, and explicitly new or changed problems.
- Objective record: procedures, imaging, studies, important results, abnormal or trended labs, and pending tests.
- Follow-up record: named appointments, monitoring, referrals, instructions, and return precautions stated in the source.
- Uncertainty: ambiguous attribution, conflicting statements, missing comparison information, negation, historical-only facts, and provisional or ruled-out conditions.

Then perform a silent verification pass:

1. Confirm every list item has a short exact `source_quote` that supports the complete claim.
2. Confirm medication change labels are supported by a documented comparison, not mere list presence or absence.
3. Confirm the subject, timing, negation, and certainty of every claim.
4. Confirm `two_page_summary` introduces no fact absent from the source.
5. Remove duplicates and speculative items; move genuinely ambiguous items to an uncertainty field.

Use empty arrays when the note does not support a target. The summary must be non-empty, clinically neutral, concise, and organized around hospitalization, course, medications, diagnoses, objective results, and explicit follow-up when those sections are supported.
