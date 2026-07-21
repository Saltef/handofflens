#!/usr/bin/env node

const assert = require("node:assert/strict");
const { analyzeLexicalOverstatement } = require("./analyze-lexical-overstatement");

const payload = {
  records: [
    {
      case_id: "case-001",
      success: true,
      source_text: [
        "DISCHARGE DIAGNOSES:",
        "No evidence of pulmonary embolism on CTA.",
        "Possible pneumonia treated empirically.",
        "Acute kidney injury improved before discharge.",
      ].join("\n"),
      extraction: {
        medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] },
        diagnosis_changes: {
          discharge: [
            { label: "pulmonary embolism", source_quote: "pulmonary embolism" },
            { label: "possible pneumonia", source_quote: "Possible pneumonia treated empirically." },
            { label: "Acute kidney injury", source_quote: "Acute kidney injury improved before discharge." },
          ],
          new_or_changed: [],
        },
        procedures_and_tests: [],
        labs: [],
        follow_up_actions: [],
        safety_flags: [],
        uncertain_items: [],
      },
    },
  ],
};

const report = analyzeLexicalOverstatement(payload);
assert.equal(report.summary.records, 1);
assert.equal(report.summary.evidence_items, 3);
assert.equal(report.summary.lexically_located_items, 3);
assert.equal(report.summary.assertion_conflict_items, 1);
assert.equal(Number(report.summary.lexical_overstatement_rate.toFixed(3)), 0.333);
assert.equal(report.summary.conflict_status_counts.absent, 1);
assert.equal(report.summary.conflict_domain_counts.diagnosis, 1);
assert.equal(report.cases[0].assertion_conflict_items, 1);

const evalReport = analyzeLexicalOverstatement({
  results: [
    {
      case_id: "case-002",
      extraction: payload.records[0].extraction,
      source_text: payload.records[0].source_text,
    },
  ],
});

assert.equal(evalReport.summary.records, 1);
assert.equal(evalReport.summary.evidence_items, 3);
assert.equal(evalReport.summary.assertion_conflict_items, 1);

console.log("PASS lexical provenance overstatement analysis (11 assertions)");
