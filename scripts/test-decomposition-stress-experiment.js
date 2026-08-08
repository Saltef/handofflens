#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  runDecompositionStressExperiment,
  METHOD_DEFINITIONS,
} = require("./run-decomposition-stress-experiment");

const sourceText = [
  "ADMISSION MEDICATIONS:",
  "Aspirin 81 mg daily.",
  "DISCHARGE MEDICATIONS:",
  "Aspirin 81 mg daily.",
  "FOLLOW-UP:",
  "Follow-up cardiology in one week.",
  "LABS:",
  "Creatinine 1.3 mg/dL.",
  "Potassium 4.9 mmol/L.",
  "DISCHARGE DIAGNOSES:",
  "Heart failure exacerbation.",
  "No pneumonia was seen.",
].join("\n");

const payload = {
  records: [
    {
      case_id: "stress-001",
      success: true,
      source_text: sourceText,
      extraction: {
        medication_changes: {
          started: [],
          stopped: [],
          changed: [],
          continued: [
            {
              label: "Aspirin 81 mg daily continued",
              source_quote: "ADMISSION MEDICATIONS: Aspirin 81 mg daily. ... DISCHARGE MEDICATIONS: Aspirin 81 mg daily.",
            },
          ],
          uncertain: [],
        },
        diagnosis_changes: {
          discharge: [
            {
              label: "Pneumonia",
              source_quote: "Pneumonia present.",
            },
          ],
          new_or_changed: [],
        },
        procedures_and_tests: [
          {
            label: "Cardiac catheterization completed",
            source_quote: "Cardiac catheterization completed without complication.",
          },
        ],
        labs: [
          {
            label: "Creatinine 1.3 mg/dL and potassium 4.9 mmol/L",
            source_quote: "Creatinine 1.3 mg/dL and potassium 4.9 mmol/L",
          },
        ],
        follow_up_actions: [
          {
            label: "Follow-up cardiology in one week",
            source_quote: "Follow up cardiology in one week",
          },
        ],
        safety_flags: [],
        uncertain_items: [],
      },
    },
  ],
};

const report = runDecompositionStressExperiment(payload, {
  taskLimit: 20,
  caseLimit: 20,
});

assert.equal(Object.keys(METHOD_DEFINITIONS).length, 5);
assert.equal(report.summary.tasks, 5);
assert.equal(report.summary.source_records, 1);

const tasksByPath = Object.fromEntries(report.tasks.map((task) => [task.path, task]));

const aspirin = tasksByPath["medication_changes.continued[0]"];
assert.equal(aspirin.methods.exact_full_note.supported, false);
assert.equal(aspirin.methods.query_aware_multispan.supported, true);
assert.equal(aspirin.methods.query_aware_multispan.selected_span_count, 2);
assert.equal(aspirin.methods.query_aware_multispan.status, "query_greedy_multispan_supported");

const followUp = tasksByPath["follow_up_actions[0]"];
assert.equal(followUp.methods.exact_full_note.supported, false);
assert.equal(followUp.methods.normalized_full_note.supported, true);
assert.equal(followUp.methods.section_filtered_span.supported, true);

const labs = tasksByPath["labs[0]"];
assert.equal(labs.methods.exact_full_note.supported, false);
assert.equal(labs.methods.line_span_id.supported, false);
assert.equal(labs.methods.query_aware_multispan.supported, true);
assert.equal(labs.methods.query_aware_multispan.selected_span_count, 2);
assert.equal(labs.methods.query_aware_multispan.status, "query_greedy_multispan_supported");

const assertionConflict = tasksByPath["diagnosis_changes.discharge[0]"];
assert.equal(assertionConflict.methods.query_aware_multispan.supported, false);
assert.equal(assertionConflict.methods.query_aware_multispan.status, "abstain_query_assertion_conflict");

const unsupported = tasksByPath["procedures_and_tests[0]"];
assert.equal(unsupported.methods.exact_full_note.supported, false);
assert.equal(unsupported.methods.normalized_full_note.supported, false);
assert.equal(unsupported.methods.line_span_id.supported, false);
assert.equal(unsupported.methods.section_filtered_span.supported, false);
assert.equal(unsupported.methods.query_aware_multispan.supported, false);

assert.equal(report.summary.methods.find((item) => item.method === "exact_full_note").supported_tasks, 0);
assert.equal(report.summary.methods.find((item) => item.method === "normalized_full_note").supported_tasks, 1);
assert.equal(report.summary.methods.find((item) => item.method === "query_aware_multispan").supported_tasks, 3);

console.log("PASS decomposition stress experiment (25 assertions)");
