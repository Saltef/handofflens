#!/usr/bin/env node
const assert = require("node:assert/strict");
const { evaluateExtraction } = require("./extraction-quality-gate");
const { planRecovery } = require("./recovery-policy");

const source = "The patient started aspirin 81 mg daily. Follow up with primary care in one week. The discharge diagnosis was pneumonia.";
const item = (label, quote) => ({ label, rationale: "Explicitly documented in source.", source_quote: quote });
function fixture() { return { case_id: "CASE_TEST", patient_context: { age: "60", gender: "F", admission_diagnosis: "Pneumonia" }, medication_changes: { started: [item("Aspirin 81 mg daily", "started aspirin 81 mg daily")], stopped: [], changed: [], continued: [], uncertain: [] }, diagnosis_changes: { admission: "Pneumonia", discharge: [item("Pneumonia", "discharge diagnosis was pneumonia")], new_or_changed: [] }, procedures_and_tests: [], labs: [], follow_up_actions: [item("Primary care in one week", "Follow up with primary care in one week")], safety_flags: [], uncertain_items: [], two_page_summary: "Hospitalized for pneumonia. Aspirin 81 mg daily was documented, with primary-care follow-up planned in one week." }; }

let output = fixture();
assert.equal(evaluateExtraction(output, { source, caseId: "CASE_TEST" }).valid, true);
output = fixture(); output.two_page_summary = "";
let gate = evaluateExtraction(output, { source, caseId: "CASE_TEST" });
assert.equal(gate.valid, false); assert.equal(planRecovery(gate).action, "summary_only_regeneration");
output = fixture(); output.follow_up_actions[0].source_quote = "quote that is not present";
gate = evaluateExtraction(output, { source, caseId: "CASE_TEST" });
assert(gate.blocking.some((x) => x.code === "source_quote_not_found")); assert.equal(planRecovery(gate).action, "targeted_evidence_reextraction");
output = fixture(); output.medication_changes.stopped.push(item("Aspirin 81 mg daily", "started aspirin 81 mg daily"));
gate = evaluateExtraction(output, { source, caseId: "CASE_TEST" });
assert(gate.blocking.some((x) => x.code === "medication_state_conflict"));
output = fixture(); output.follow_up_actions.push({ ...output.follow_up_actions[0] });
gate = evaluateExtraction(output, { source, caseId: "CASE_TEST" });
assert(gate.blocking.some((x) => x.code === "duplicate_evidence_item"));
output = fixture(); output.case_id = "WRONG";
assert(evaluateExtraction(output, { source, caseId: "CASE_TEST" }).blocking.some((x) => x.code === "case_id_mismatch"));
console.log("PASS extraction quality gate and recovery policy (6 scenarios)");
