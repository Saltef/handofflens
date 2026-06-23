#!/usr/bin/env node
const assert = require("node:assert/strict");
const { indexSource, renderIndexedSource, materializeExtraction } = require("./source-evidence-index");
const { evaluateExtraction } = require("./extraction-quality-gate");

const source = "Admission diagnosis: pneumonia.\n\nStarted aspirin 81 mg daily.\nFollow up in one week.";
const index = indexSource(source);
assert.deepEqual(index.segments.map((x) => x.id), ["L0001", "L0002", "L0003"]);
assert(renderIndexedSource(index).includes("L0002 | Started aspirin"));
const item = (label, start, end = start) => ({ label, rationale: "Explicit in source", source_start_id: start, source_end_id: end });
const pointer = { case_id: "CASE_TEST", patient_context: { age: "60", gender: "F", admission_diagnosis: "pneumonia" }, medication_changes: { started: [item("Aspirin", "L0002")], stopped: [], changed: [], continued: [], uncertain: [] }, diagnosis_changes: { admission: "pneumonia", discharge: [item("Pneumonia", "L0001")], new_or_changed: [] }, procedures_and_tests: [], labs: [], follow_up_actions: [item("Follow up", "L0003")], safety_flags: [], uncertain_items: [], two_page_summary: "Hospitalized with pneumonia. Aspirin was documented, and follow-up was planned for one week." };
const materialized = materializeExtraction(pointer, index);
assert.equal(materialized.medication_changes.started[0].source_quote, "Started aspirin 81 mg daily.");
assert.equal(evaluateExtraction(materialized, { source, caseId: "CASE_TEST" }).valid, true);
const invalid = structuredClone(pointer); invalid.follow_up_actions[0].source_start_id = "L0003"; invalid.follow_up_actions[0].source_end_id = "L0001";
assert.throws(() => materializeExtraction(invalid, index), /reversed/);
const unknown = structuredClone(pointer); unknown.follow_up_actions[0].source_start_id = "L9999";
assert.throws(() => materializeExtraction(unknown, index), /unknown identifier/);
console.log("PASS source evidence index (5 scenarios)");
