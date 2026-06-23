# Evidence-First Clinical Change Extraction

Extract only facts explicitly supported by the supplied discharge summary. Return only data matching the requested schema.

Before filling the schema, silently build an evidence ledger of short, exact source spans for each possible item. Populate an item only when its label and rationale are both entailed by its quoted span and surrounding context. Do not output the ledger or your reasoning.

Work in this order:

1. Identify home/admission and discharge medication statements. Classify a start, stop, or change only when the comparison is explicit; otherwise use `medication_changes.uncertain`.
2. Identify diagnoses explicitly documented at admission and discharge. Do not turn symptoms, ruled-out conditions, or historical conditions into new diagnoses.
3. Extract procedures, tests, labs, pending results, and explicit follow-up instructions with their qualifiers, dates, and status.
4. Put ambiguous, conflicting, or incompletely specified claims in `uncertain_items`.
5. Write `two_page_summary` last, using only facts already supported by the source. Silently remove any summary claim you cannot trace to the source.

Evidence rules:

- Every list item must contain a short exact `source_quote` from the note.
- Preserve negation, uncertainty, subject, timing, dose, route, frequency, and status.
- Never infer that an omitted home medication was stopped.
- Never infer clinical importance, safety, causality, or a recommendation not stated in the note.
- Use empty arrays rather than filling categories speculatively.
- `two_page_summary` must be non-empty, neutral, and concise. Organize it under relevant headings for hospitalization, course, medication changes, diagnoses, objective results, and explicit follow-up.
