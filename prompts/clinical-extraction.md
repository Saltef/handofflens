# Clinical Change Extraction Prompt

You are extracting clinically relevant changes from a de-identified hospital discharge summary for physician follow-up review.

Return only structured data matching the requested schema. Do not invent facts. Do not infer beyond the supplied discharge summary and metadata. If an item is plausible but not explicitly supported, include it in `uncertain_items` instead of a definitive category.

Focus on follow-up care:

- Medication starts, stops, dose changes, duration changes, and high-risk medications
- New or changed diagnoses from admission to discharge
- Procedures, invasive studies, imaging, and important results
- Abnormal labs, trends, and pending tests
- Follow-up appointments, monitoring needs, and source-stated safety flags
- Source-grounded handoff atoms that preserve complete actionable details before they are projected into category fields

Rules:

- Every extracted item must include a short exact `source_quote` copied from the discharge summary.
- Fill `handoff_atoms` before filling the compatibility category fields. Each atom should represent one source-grounded fact, instruction, or contingency, with complete action, target, timing, threshold, owner, and source quote when those details are present.
- Treat `follow_up_actions`, `safety_flags`, `labs`, `procedures_and_tests`, and other category arrays as derived views over `handoff_atoms`. If a handoff atom has `derived_views` containing `follow_up_actions` or `safety_flags`, the corresponding category array must contain a matching item.
- Prefer recall for follow-up-critical items, but never add unsupported facts.
- Medication changes should compare home/admission medications with discharge medications when both are documented.
- If a home medication is absent from discharge medications, mark it stopped only when the source supports that interpretation; otherwise place it in `uncertain`.
- Safety flags are source-stated contingency, warning, or monitoring items. Do not use `safety_flags` for broad inferred themes such as "wound monitoring", "renal function monitoring", "diabetes management", or "watch for infection" unless the source states the exact trigger, action, or test.
- Each safety flag must have `safety_type`:
  - `return_precaution`: explicit return/call/seek-care trigger, usually "return for X" or "call if Y".
  - `monitoring_instruction`: explicit measurement, lab check, symptom log, weight log, or other source-stated monitoring task.
  - `medication_safety`: explicit medication risk, dosing issue, stop/hold warning, interaction, toxicity, or high-risk medication instruction.
  - `pending_or_critical_result`: pending test, critical result, or result requiring named follow-up.
  - `source_stated_risk`: other risk explicitly stated by the source, not inferred from clinical background.
- Prefer atomic safety flags. If the source says "Return promptly for fever, spreading redness, increasing drainage, or severe pain", extract four `return_precaution` items with the same source quote, not one broad "wound monitoring" item.
- Preserve all actionable qualifiers in atom labels and projected category labels. Do not drop time windows, thresholds, tests, or triggers. For example, preserve `in 3 days` in "call for a gain above 2 kg in 3 days" and preserve both targets in "potassium and creatinine in 3 days".
- If a safety concern is clinically plausible but not source-stated, place it in `uncertain_items` instead of `safety_flags`.
- For source-stated follow-up instructions:
  - appointments use `instruction_kind: "appointment"` and `derived_views: ["follow_up_actions"]`;
  - lab checks use `instruction_kind: "lab_monitoring"` and usually `safety_type: "monitoring_instruction"` with `derived_views: ["follow_up_actions", "safety_flags"]`;
  - self-monitoring tasks use `instruction_kind: "self_monitoring"` and `derived_views: ["follow_up_actions"]`;
  - call/return triggers use `instruction_kind: "return_precaution"` and `safety_type: "return_precaution"` with `derived_views: ["safety_flags"]`.
- The `two_page_summary` must never be empty. It should be clinically neutral, organized for a physician, and useful for follow-up care. It must not contain facts absent from the structured fields or source text.
- Write the `two_page_summary` as a sectioned physician handoff using these headings when supported by the source: Reason for hospitalization and main problems; Hospital course and treatments; Medication changes; New or changed diagnoses; Tests, procedures, and labs; Follow-up actions and safety concerns.
- For very short source notes, write a concise but complete summary. For longer source notes, include enough detail that a follow-up physician can understand medication changes, diagnosis changes, objective data, pending tests, and safety risks without rereading the entire discharge summary.
