#!/usr/bin/env node

const assert = require("node:assert/strict");
const { selectMinimalEvidence } = require("./minimal-evidence-selector");

const sourceText = [
  "ADMISSION MEDICATIONS: Lasix 40 mg daily.",
  "DISCHARGE MEDICATIONS: Furosemide 20 mg daily.",
  "LABS: Creatinine 1.3 mg/dL / Potassium 4.9 mmol/L.",
  "DISCHARGE DIAGNOSES: No pneumonia was seen.",
].join("\n");

const changedMedication = selectMinimalEvidence(sourceText, {
  label: "Lasix changed to furosemide 20 mg daily",
  source_quote: 'Admission: "Lasix 40 mg daily." Discharge: "Furosemide 20 mg daily."',
  assertion: "present",
});

assert.equal(changedMedication.supported, true);
assert.equal(changedMedication.support_status, "supported");
assert.deepEqual(changedMedication.evidence_span_ids, ["S1", "S2"]);
assert.equal(changedMedication.selected_span_count, 2);
assert.ok(changedMedication.selected_context_words < 12);
assert.equal(changedMedication.assertion_conflict, false);
assert.equal(changedMedication.label_risk, false);

const labs = selectMinimalEvidence(sourceText, {
  label: "Creatinine 1.3 mg/dL and potassium 4.9 mmol/L",
  source_quote: "Creatinine 1.3 mg/dL and potassium 4.9 mmol/L",
  assertion: "present",
});

assert.equal(labs.supported, true);
assert.deepEqual(labs.evidence_span_ids, ["S3", "S4"]);

const negatedDiagnosis = selectMinimalEvidence(sourceText, {
  label: "Pneumonia",
  source_quote: "Pneumonia present.",
  assertion: "present",
});

assert.equal(negatedDiagnosis.supported, false);
assert.equal(negatedDiagnosis.support_status, "not_found");
assert.equal(negatedDiagnosis.rejected_counts.assertion_conflict, 1);

const missing = selectMinimalEvidence(sourceText, {
  label: "Cardiac catheterization completed",
  source_quote: "Cardiac catheterization completed without complication.",
  assertion: "present",
});

assert.equal(missing.supported, false);
assert.equal(missing.support_status, "not_found");
assert.deepEqual(missing.evidence_span_ids, []);

console.log("PASS minimal evidence selector (16 assertions)");
