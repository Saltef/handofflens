#!/usr/bin/env node

const assert = require("node:assert/strict");
const { analyzeAdjudicatedGold } = require("./analyze-adjudicated-gold");

const gold = {
  schema_version: "adjudicated-extraction-gold-v1",
  cases: [
    {
      case_id: "case-001",
      gold_items: [
        { item_id: "g1", domain: "diagnosis", label: "acute kidney injury", source_quote: "Acute kidney injury improved before discharge." },
        { item_id: "g2", domain: "follow_up", label: "nephrology follow up", source_quote: "Follow up with nephrology in one week." },
      ],
    },
    {
      case_id: "case-002",
      gold_items: [
        { item_id: "g3", domain: "diagnosis", label: "pneumonia", source_quote: "Pneumonia treated with antibiotics." },
      ],
    },
  ],
};

const predictions = {
  records: [
    {
      case_id: "case-001",
      extraction: {
        medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] },
        diagnosis_changes: { discharge: [{ label: "acute kidney injury", source_quote: "Acute kidney injury improved before discharge." }], new_or_changed: [] },
        procedures_and_tests: [],
        labs: [],
        follow_up_actions: [
          { label: "nephrology follow-up", source_quote: "Follow up with nephrology in one week." },
          { label: "cardiology follow-up", source_quote: "Cardiology as needed." },
        ],
        safety_flags: [],
        uncertain_items: [],
      },
    },
    {
      case_id: "case-002",
      extraction: {
        medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] },
        diagnosis_changes: { discharge: [], new_or_changed: [] },
        procedures_and_tests: [],
        labs: [],
        follow_up_actions: [],
        safety_flags: [],
        uncertain_items: [],
      },
    },
  ],
};

const report = analyzeAdjudicatedGold({ gold, predictions, minScore: 0.72 });
assert.equal(report.summary.cases, 2);
assert.equal(report.summary.gold_items, 3);
assert.equal(report.summary.predicted_items, 3);
assert.equal(report.summary.true_positives, 2);
assert.equal(report.summary.false_positives, 1);
assert.equal(report.summary.false_negatives, 1);
assert.equal(Number(report.summary.precision.toFixed(3)), 0.667);
assert.equal(Number(report.summary.recall.toFixed(3)), 0.667);
assert.equal(report.by_domain.diagnosis.true_positives, 1);
assert.equal(report.by_domain.diagnosis.false_negatives, 1);
assert.equal(report.by_domain.follow_up.false_positives, 1);

console.log("PASS adjudicated gold precision/recall analysis (11 assertions)");
