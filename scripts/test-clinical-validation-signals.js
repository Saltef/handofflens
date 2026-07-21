#!/usr/bin/env node
const assert = require("node:assert/strict");
const { detectAssertionStatus, validateEvidenceSemantics } = require("./clinical-validation-signals");

const source = [
  "DISCHARGE DIAGNOSES:",
  "No evidence of pulmonary embolism on CTA.",
  "Possible pneumonia, treated empirically.",
  "Return for chest pain if symptoms recur.",
  "History of atrial fibrillation, resolved after ablation.",
  "Family history of colon cancer in father.",
  "Acute kidney injury improved before discharge.",
].join("\n");

assert.equal(detectAssertionStatus({ sourceText: source, quote: "pulmonary embolism", label: "pulmonary embolism" }).status, "absent");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "pneumonia", label: "pneumonia" }).status, "possible");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "chest pain", label: "chest pain" }).status, "conditional");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "atrial fibrillation", label: "atrial fibrillation" }).status, "historical");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "colon cancer", label: "colon cancer" }).status, "associated_with_someone_else");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "Acute kidney injury", label: "Acute kidney injury" }).status, "present");
assert.equal(detectAssertionStatus({ sourceText: "No fever but has pneumonia.", quote: "pneumonia", label: "pneumonia" }).status, "present");
assert.equal(detectAssertionStatus({ sourceText: source, quote: "missing target", label: "pneumonia" }).status, "present");

const extraction = {
  medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] },
  diagnosis_changes: {
    discharge: [
      { label: "pulmonary embolism", source_quote: "pulmonary embolism" },
      { label: "possible pneumonia", source_quote: "Possible pneumonia, treated empirically." },
      { label: "history of atrial fibrillation", source_quote: "atrial fibrillation" },
      { label: "Acute kidney injury", source_quote: "Acute kidney injury improved before discharge." },
    ],
    new_or_changed: [],
  },
  procedures_and_tests: [],
  labs: [],
  follow_up_actions: [],
  safety_flags: [],
  uncertain_items: [],
  two_page_summary: "AKI improved.",
};
const validation = validateEvidenceSemantics(extraction, { sourceText: source });
const assertionIssues = validation.issues.filter((issue) => issue.code === "possible_assertion_status_conflict");
assert.equal(assertionIssues.length, 1);
assert.equal(assertionIssues[0].details.status, "absent");
assert.equal(assertionIssues[0].path, "diagnosis_changes.discharge[0]");

const safetySource = "FOLLOW-UP: Primary care laboratory check for potassium and creatinine in 3 days. Return promptly for fever, spreading redness, increasing drainage, or severe pain.";
const safetyExtraction = {
  medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] },
  diagnosis_changes: { discharge: [], new_or_changed: [] },
  procedures_and_tests: [],
  labs: [],
  follow_up_actions: [],
  safety_flags: [
    { label: "Potassium and creatinine lab check in 3 days", safety_type: "monitoring_instruction", source_quote: "Primary care laboratory check for potassium and creatinine in 3 days." },
    { label: "fever", safety_type: "return_precaution", source_quote: "Return promptly for fever, spreading redness, increasing drainage, or severe pain." },
    { label: "Wound monitoring for signs of infection", safety_type: "return_precaution", source_quote: "Return promptly for fever, spreading redness, increasing drainage, or severe pain." },
    { label: "Renal function monitoring required", source_quote: "Primary care laboratory check for potassium and creatinine in 3 days." },
    { label: "Antibiotic therapy completion monitoring", safety_type: "monitoring_instruction", source_quote: "Cephalexin 500 mg four times daily for 5 more days." },
  ],
  uncertain_items: [],
  two_page_summary: "Follow-up includes labs and return precautions.",
};

const safetyValidation = validateEvidenceSemantics(safetyExtraction, { sourceText: safetySource });
assert.equal(safetyValidation.issues.filter((issue) => issue.code === "missing_safety_type").length, 1);
assert.equal(safetyValidation.issues.filter((issue) => issue.code === "broad_safety_abstraction").length, 3);
assert.equal(safetyValidation.issues.filter((issue) => issue.code === "monitoring_instruction_without_monitoring_cue").length, 1);
assert.equal(safetyValidation.issues.some((issue) => issue.path === "safety_flags[0]" && /safety/.test(issue.code)), false);
assert.equal(safetyValidation.issues.some((issue) => issue.path === "safety_flags[1]" && /safety|return/.test(issue.code)), false);

console.log("PASS clinical validation assertion-status and safety-flag checks (15 assertions)");
