#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  analyzeProvenanceMissTaxonomy,
  diagnoseEvidenceItem,
} = require("./analyze-provenance-miss-taxonomy");

const sourceText = [
  "DISCHARGE MEDICATIONS:",
  "Amlodipine 5 mg daily.",
  "Follow-up cardiology in one week.",
  "Admission medications: aspirin 81 mg daily.",
  "Discharge medications: aspirin 81 mg daily.",
  "The patient had hypertension.",
  "Renal function: creatinine was 1.3 mg/dL on discharge.",
].join("\n");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Amlodipine 5 mg daily",
  sourceQuote: "Amlodipine 5 mg daily.",
}).miss_category, "exact_contiguous");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Follow-up cardiology in one week",
  sourceQuote: "Follow up cardiology in one week",
}).miss_category, "normalization_or_punctuation");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Aspirin continued",
  sourceQuote: "Admission medications: aspirin 81 mg daily. ... Discharge medications: aspirin 81 mg daily.",
}).miss_category, "quote_terms_present_noncontiguous");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Creatinine 1.3 mg/dL",
  sourceQuote: "Renal creatinine 1.3 mg dL repeat",
}).miss_category, "high_overlap_pointer_drift");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Hypertension",
  sourceQuote: "Pulmonary clinic tomorrow",
}).miss_category, "label_supported_quote_unresolved");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Cardiology plan",
  sourceQuote: "cardiology outpatient",
}).miss_category, "weak_overlap_needs_review");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "Cardiac catheterization",
  sourceQuote: "cardiac catheterization completed",
}).miss_category, "low_overlap_possible_fabrication");

assert.equal(diagnoseEvidenceItem({
  sourceText,
  label: "No quote",
  sourceQuote: "",
}).miss_category, "missing_quote");

assert.equal(diagnoseEvidenceItem({
  sourceText: "",
  label: "No source",
  sourceQuote: "anything",
}).miss_category, "missing_source_text");

const report = analyzeProvenanceMissTaxonomy({
  records: [
    {
      case_id: "case-001",
      success: true,
      source_text: sourceText,
      extraction: {
        medication_changes: {
          started: [{ label: "Amlodipine 5 mg daily", source_quote: "Amlodipine 5 mg daily." }],
          continued: [{ label: "Aspirin continued", source_quote: "Admission medications: aspirin 81 mg daily. ... Discharge medications: aspirin 81 mg daily." }],
          stopped: [],
          changed: [],
          uncertain: [],
        },
        diagnosis_changes: {
          discharge: [{ label: "Hypertension", source_quote: "Pulmonary clinic tomorrow" }],
          new_or_changed: [],
        },
        procedures_and_tests: [{ label: "Cardiac catheterization", source_quote: "cardiac catheterization completed" }],
        labs: [],
        follow_up_actions: [{ label: "Follow-up cardiology in one week", source_quote: "Follow up cardiology in one week" }],
        safety_flags: [],
        uncertain_items: [],
      },
    },
  ],
});

assert.equal(report.summary.records, 1);
assert.equal(report.summary.completed_records, 1);
assert.equal(report.summary.evidence_items, 5);
assert.equal(report.summary.exact_quote_items, 1);
assert.equal(report.summary.exact_quote_miss_items, 4);
assert.equal(report.summary.exact_case_gate_passes, 0);
assert.equal(report.summary.exact_miss_category_counts.normalization_or_punctuation, 1);
assert.equal(report.summary.exact_miss_category_counts.quote_terms_present_noncontiguous, 1);
assert.equal(report.summary.exact_miss_category_counts.label_supported_quote_unresolved, 1);
assert.equal(report.summary.exact_miss_category_counts.low_overlap_possible_fabrication, 1);
assert.equal(report.summary.strictness_or_pointer_artifact_items, 3);
assert.equal(report.summary.possible_fabrication_items, 1);
assert.equal(report.summary.span_supported_items, 4);
assert.equal(report.summary.exact_miss_span_supported_items, 3);
assert.equal(report.summary.provenance_abstain_items, 1);
assert.equal(report.summary.single_span_supported_items, 3);
assert.equal(report.summary.multi_span_supported_items, 1);
assert.equal(report.summary.entailment_ready_items, 4);
assert.equal(report.summary.span_support_status_counts.strict_exact_contiguous, 1);
assert.equal(report.summary.span_support_status_counts.normalized_single_span, 1);
assert.equal(report.summary.span_support_status_counts.multi_span_recovered, 1);
assert.equal(report.summary.span_support_status_counts.label_span_recovered, 1);
assert.equal(report.summary.span_support_status_counts.abstain_low_overlap, 1);

const items = Object.fromEntries(report.cases[0].items.map((item) => [item.path, item]));
assert.equal(items["medication_changes.started[0]"].span_support.status, "strict_exact_contiguous");
assert.deepEqual(items["medication_changes.started[0]"].span_support.span_ids, ["L0002"]);
assert.equal(items["medication_changes.continued[0]"].span_support.status, "multi_span_recovered");
assert.deepEqual(items["medication_changes.continued[0]"].span_support.span_ids, ["L0004", "L0005"]);
assert.equal(items["diagnosis_changes.discharge[0]"].span_support.status, "label_span_recovered");
assert.deepEqual(items["diagnosis_changes.discharge[0]"].span_support.span_ids, ["L0006"]);
assert.equal(items["procedures_and_tests[0]"].span_support.status, "abstain_low_overlap");
assert.equal(items["follow_up_actions[0]"].span_support.status, "normalized_single_span");
assert.equal(items["follow_up_actions[0]"].span_support.entailment_input.status, "ready_for_entailment_scorer");

console.log("PASS provenance miss taxonomy analysis (43 assertions)");
