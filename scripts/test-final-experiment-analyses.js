#!/usr/bin/env node

const assert = require("node:assert/strict");
const { analyzeMinimalSelectorRecall } = require("./analyze-minimal-selector-recall");
const { analyzeLengthDensityConfounding } = require("./analyze-length-density-confounding");
const { wilsonInterval, rateSummary, formatRate } = require("./experiment-metrics");

assert.deepEqual(wilsonInterval(0, 10), [0, 0.2775]);
assert.equal(rateSummary(3, 4).rate, 0.75);
assert.match(formatRate(rateSummary(3, 4)), /3\/4, 75\.0%/);

const sourceText = [
  "ADMISSION MEDICATIONS:",
  "Lasix 40 mg daily.",
  "DISCHARGE MEDICATIONS:",
  "Furosemide 20 mg daily.",
  "DISCHARGE DIAGNOSES:",
  "No pneumonia was seen.",
].join("\n");

const recall = analyzeMinimalSelectorRecall({
  records: [{
    case_id: "case-1",
    success: true,
    source_text: sourceText,
    extraction: {
      medication_changes: {
        started: [],
        stopped: [],
        changed: [{
          label: "Lasix changed to furosemide 20 mg daily",
          source_quote: 'Admission: "Lasix 40 mg daily." Discharge: "Furosemide 20 mg daily."',
        }],
        continued: [],
        uncertain: [],
      },
      diagnosis_changes: {
        discharge: [{ label: "Pneumonia", source_quote: "Pneumonia present." }],
        new_or_changed: [],
      },
      procedures_and_tests: [],
      labs: [],
      follow_up_actions: [],
      safety_flags: [],
      uncertain_items: [],
    },
  }],
}, { taskLimit: 10, caseLimit: 10 });

assert.equal(recall.summary.tasks, 2);
assert.equal(recall.summary.old_query_aware_support.numerator, 1);
assert.equal(recall.summary.minimal_selector_support.numerator, 1);
assert.equal(recall.summary.recall_cost_among_old_supported.numerator, 0);
assert.equal(recall.summary.minimal_selector_support_status_counts.supported, 1);
assert.equal(recall.summary.minimal_selector_support_status_counts.not_found, 1);

const density = analyzeLengthDensityConfounding({
  cases: [
    caseSummary({ words: 900, items: 30, exact: 20, span: 28, abstain: 2 }),
    caseSummary({ words: 1000, items: 18, exact: 10, span: 15, abstain: 3 }),
    caseSummary({ words: 2500, items: 20, exact: 12, span: 15, abstain: 5 }),
    caseSummary({ words: 2600, items: 60, exact: 30, span: 45, abstain: 15 }),
  ],
}, { shortWordThreshold: 1500, highDensityThreshold: 16 });

assert.equal(density.summary.completed_records, 4);
assert.equal(density.summary.cells.short_high_density.records, 2);
assert.equal(density.summary.cells.long_low_density.records, 1);
assert.equal(density.summary.conclusion, "off_diagonal_cells_too_thin");

console.log("PASS final experiment analyses (16 assertions)");

function caseSummary({ words, items, exact, span, abstain }) {
  return {
    success: true,
    source_word_count: words,
    evidence_items: items,
    exact_quote_items: exact,
    span_supported_items: span,
    provenance_abstain_items: abstain,
  };
}
