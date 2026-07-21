#!/usr/bin/env node
const assert = require("node:assert/strict");
const { indexSource, materializeExtractionWithAudit } = require("./source-evidence-index");
const { detectClinicalSignals, compareSignalsToExtraction, validateEvidenceSemantics } = require("./clinical-validation-signals");

const source = "DISCHARGE DIAGNOSES:\nPneumonia\nDISCHARGE MEDICATIONS:\nAspirin 81 mg daily\nFOLLOW-UP:\nClinic in one week";
const signals = detectClinicalSignals(source);
assert.equal(signals.domains.medication_changes.present, true);
assert.equal(signals.domains.diagnosis_changes.present, true);
assert.equal(signals.domains.follow_up_actions.present, true);

const item = (label, start, end = start) => ({ label, rationale: "Explicit", source_start_id: start, source_end_id: end });
const pointer = { case_id: "TEST", patient_context: { age: "60", gender: "F", admission_diagnosis: "pneumonia" }, medication_changes: { started: [item("Aspirin 81 mg", "L0004")], stopped: [], changed: [], continued: [], uncertain: [] }, diagnosis_changes: { admission: "pneumonia", discharge: [item("Pneumonia", "L0002")], new_or_changed: [] }, procedures_and_tests: [], labs: [], follow_up_actions: [item("Clinic in one week", "L0006")], safety_flags: [], uncertain_items: [] };
const materialized = materializeExtractionWithAudit(pointer, indexSource(source), { repairReversed: true, maxRepairSpanLines: 3, maxSpanLines: 3 });
assert.equal(materialized.extraction.medication_changes.started[0].source_quote, "Aspirin 81 mg daily");
assert.deepEqual(compareSignalsToExtraction(signals, materialized.extraction).missing_signaled_domains, []);
assert.equal(validateEvidenceSemantics(materialized.extraction).valid, true);
const summaryCheck = structuredClone(materialized.extraction);
summaryCheck.two_page_summary = "The patient received an unsupported dose of 999 mg during the documented hospitalization.";
assert.equal(validateEvidenceSemantics(summaryCheck).issues.some((x) => x.code === "summary_numeric_detail_not_in_accepted_evidence"), true);

const reversed = structuredClone(pointer);
reversed.follow_up_actions[0].source_start_id = "L0006";
reversed.follow_up_actions[0].source_end_id = "L0005";
const repaired = materializeExtractionWithAudit(reversed, indexSource(source), { repairReversed: true, maxRepairSpanLines: 3, maxSpanLines: 3 });
assert.equal(repaired.audit[0].code, "reversed_span_repaired");
assert.equal(repaired.extraction.follow_up_actions[0].source_quote, "FOLLOW-UP:\nClinic in one week");

const tooWide = structuredClone(pointer);
tooWide.follow_up_actions[0].source_start_id = "L0001";
tooWide.follow_up_actions[0].source_end_id = "L0006";
assert.throws(() => materializeExtractionWithAudit(tooWide, indexSource(source), { maxSpanLines: 3 }), /exceeds maximum/);
const dropped = materializeExtractionWithAudit(tooWide, indexSource(source), { maxSpanLines: 3, dropInvalidItems: true });
assert.equal(dropped.extraction.follow_up_actions.length, 0);
assert.equal(dropped.audit[0].code, "invalid_span_item_rejected");

const vacuous = structuredClone(pointer);
for (const list of Object.values(vacuous.medication_changes)) list.splice(0);
vacuous.diagnosis_changes.discharge = [];
vacuous.follow_up_actions = [];
assert.deepEqual(compareSignalsToExtraction(signals, vacuous).missing_signaled_domains.sort(), ["diagnosis_changes", "follow_up_actions", "medication_changes"].sort());
console.log("PASS evidence pipeline v3 deterministic checks (10 assertions)");
