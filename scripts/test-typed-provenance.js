#!/usr/bin/env node

const assert = require("node:assert/strict");
const { classifyTypedProvenance, expandKnownTerms } = require("./typed-provenance");
const { analyzeTypedProvenance } = require("./analyze-typed-provenance");

const sourceText = [
  "Metoprolol tartrate 25 mg, 1 tab PO twice daily - NEW.",
  "No evidence of pulmonary embolism on CTA.",
  "Acute kidney injury improved before discharge.",
  "Follow up with nephrology in one week.",
  "Cardiology as needed.",
  "Potassium was 3.1 mmol/L after diuresis and was replaced.",
  "Potassium was low after diuresis and was replaced.",
  "Potassium was 3.1 mmol/L after diuresis.",
  "The wound was surgically debrided.",
].join("\n");

assert.equal(expandKnownTerms("AKI"), "acute kidney injury");
assert.equal(expandKnownTerms("PE"), "pe");
assert.equal(classifyTypedProvenance({ sourceText, label: "Acute kidney injury", quote: "Acute kidney injury improved before discharge." }).type, "direct_quote");
assert.equal(classifyTypedProvenance({ sourceText, label: "metoprolol tartrate 25 mg oral twice daily", quote: "Metoprolol tartrate 25 mg, 1 tab PO twice daily - NEW." }).type, "normalized");
assert.equal(classifyTypedProvenance({ sourceText, label: "pulmonary embolism", quote: "pulmonary embolism" }).type, "assertion_conflict");
assert.equal(classifyTypedProvenance({ sourceText, label: "nephrology appointment", quote: "Follow up with nephrology in one week." }).type, "inferential");
assert.equal(classifyTypedProvenance({ sourceText, label: "cardiac catheterization", quote: "Cardiology as needed." }).type, "unsupported");
assert.equal(classifyTypedProvenance({ sourceText, label: "Simvastatin 20 mg nightly stopped", quote: "Simvastatin was stopped because of muscle pain.", domain: "medication_changes.stopped[0]" }).type, "inferential");
assert.equal(classifyTypedProvenance({ sourceText, label: "Echocardiogram performed", quote: "Echocardiogram showed an ejection fraction of 35 percent.", domain: "procedures_and_tests[0]" }).type, "inferential");
assert.equal(classifyTypedProvenance({ sourceText, label: "Hypokalemia, corrected", quote: "Potassium was 3.1 mmol/L after diuresis and was replaced.", domain: "diagnosis_changes.discharge[0]" }).type, "inferential");
assert.equal(classifyTypedProvenance({ sourceText, label: "Hypokalemia, corrected", quote: "Potassium was low after diuresis and was replaced.", domain: "diagnosis_changes.discharge[0]" }).type, "inferential");
assert.equal(classifyTypedProvenance({ sourceText, label: "Hypokalemia, corrected", quote: "Potassium was 3.1 mmol/L after diuresis.", domain: "diagnosis_changes.discharge[0]" }).type, "unsupported");
assert.equal(classifyTypedProvenance({ sourceText, label: "Surgical debridement of left lower-leg wound", quote: "The wound was surgically debrided.", domain: "procedures_and_tests[0]" }).type, "inferential");

const report = analyzeTypedProvenance({
  records: [
    {
      case_id: "case-001",
      source_text: sourceText,
      extraction: {
        medication_changes: {
          started: [{ label: "metoprolol tartrate 25 mg oral twice daily", source_quote: "Metoprolol tartrate 25 mg, 1 tab PO twice daily - NEW." }],
          stopped: [],
          changed: [],
          continued: [],
          uncertain: [],
        },
        diagnosis_changes: {
          discharge: [
            { label: "Acute kidney injury", source_quote: "Acute kidney injury improved before discharge." },
            { label: "pulmonary embolism", source_quote: "pulmonary embolism" },
          ],
          new_or_changed: [],
        },
        procedures_and_tests: [],
        labs: [],
        follow_up_actions: [{ label: "nephrology appointment", source_quote: "Follow up with nephrology in one week." }],
        safety_flags: [],
        uncertain_items: [],
      },
    },
  ],
});

assert.equal(report.summary.evidence_items, 4);
assert.equal(report.summary.type_counts.direct_quote, 1);
assert.equal(report.summary.type_counts.normalized, 1);
assert.equal(report.summary.type_counts.assertion_conflict, 1);
assert.equal(report.summary.type_counts.inferential, 1);

const evalReport = analyzeTypedProvenance({
  results: [
    {
      case_id: "case-002",
      source_text: sourceText,
      extraction: report.cases[0] ? {
        medication_changes: {
          started: [{ label: "metoprolol tartrate 25 mg oral twice daily", source_quote: "Metoprolol tartrate 25 mg, 1 tab PO twice daily - NEW." }],
          stopped: [],
          changed: [],
          continued: [],
          uncertain: [],
        },
        diagnosis_changes: {
          discharge: [
            { label: "Acute kidney injury", source_quote: "Acute kidney injury improved before discharge." },
            { label: "pulmonary embolism", source_quote: "pulmonary embolism" },
          ],
          new_or_changed: [],
        },
        procedures_and_tests: [],
        labs: [],
        follow_up_actions: [{ label: "nephrology appointment", source_quote: "Follow up with nephrology in one week." }],
        safety_flags: [],
        uncertain_items: [],
      } : {},
    },
  ],
});

assert.equal(evalReport.summary.records, 1);
assert.equal(evalReport.summary.evidence_items, 4);
assert.equal(evalReport.summary.type_counts.assertion_conflict, 1);

console.log("PASS typed provenance classification and analysis (21 assertions)");
