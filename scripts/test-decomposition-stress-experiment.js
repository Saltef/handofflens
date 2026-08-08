#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  runDecompositionStressExperiment,
  buildGuardCalibrationCurve,
  buildSpanBudgetCurve,
  isHighRiskLabelOnlyUnion,
  isBudgetNormalizedLabelRiskUnion,
  isStrictLowOverlapRescue,
  METHOD_DEFINITIONS,
  GUARD_CONDITIONS,
  SPAN_BUDGETS,
  SPAN_BUDGET_MATCHERS,
} = require("./run-decomposition-stress-experiment");

const sourceText = [
  "ADMISSION MEDICATIONS:",
  "Aspirin 81 mg daily.",
  "Lasix 40 mg daily.",
  "DISCHARGE MEDICATIONS:",
  "Aspirin 81 mg daily.",
  "Furosemide 20 mg daily.",
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
          changed: [
            {
              label: "Lasix changed to furosemide 20 mg daily",
              source_quote: 'Admission: "Lasix 40 mg daily." Discharge: "Furosemide 20 mg daily."',
            },
          ],
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
assert.deepEqual(SPAN_BUDGETS, [1, 2, 4, 8]);
assert.equal(Object.keys(SPAN_BUDGET_MATCHERS).length, 2);
assert.deepEqual(Object.keys(GUARD_CONDITIONS), [
  "all_guards_active",
  "label_risk_disabled",
  "all_guards_disabled",
  "budget_normalized_label_risk",
]);
assert.equal(report.summary.tasks, 6);
assert.equal(report.summary.source_records, 1);
assert.equal(report.summary.span_budget_curves.lexical_topk["1"].tasks, 6);
assert.equal(report.summary.span_budget_curves.transparent_rerank_topk["8"].tasks, 6);
assert.equal(report.summary.guard_calibration_curves.transparent_rerank_topk.all_guards_active["4"].tasks, 6);
assert.equal(report.summary.guard_calibration_curves.transparent_rerank_topk.all_guards_disabled["4"].tasks, 6);
assert.equal(report.summary.guard_calibration_curves.transparent_rerank_topk.all_guards_disabled["4"].active_label_risk_tasks, 0);
assert.ok(report.summary.guard_calibration_curves.transparent_rerank_topk.all_guards_disabled["4"].raw_label_risk_tasks >= 0);
assert.equal(typeof report.summary.adaptive_query_aware_span_counts.median_all_tasks, "number");

const tasksByPath = Object.fromEntries(report.tasks.map((task) => [task.path, task]));

const aspirin = tasksByPath["medication_changes.continued[0]"];
assert.equal(aspirin.methods.exact_full_note.supported, false);
assert.equal(aspirin.methods.query_aware_multispan.supported, true);
assert.equal(aspirin.methods.query_aware_multispan.selected_span_count, 2);
assert.equal(aspirin.methods.query_aware_multispan.status, "query_greedy_multispan_supported");
assert.ok(aspirin.span_budget_curve.lexical_topk["2"].selected_span_count <= 2);
assert.ok(aspirin.span_budget_curve.transparent_rerank_topk["4"].selected_context_words > 0);

const lasix = tasksByPath["medication_changes.changed[0]"];
assert.equal(lasix.methods.exact_full_note.supported, false);
assert.equal(lasix.methods.normalized_full_note.supported, false);
assert.equal(lasix.methods.query_aware_multispan.supported, true);
assert.equal(lasix.methods.query_aware_multispan.selected_span_count, 2);
assert.equal(lasix.methods.query_aware_multispan.status, "query_multispan_supported");

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
assert.equal(assertionConflict.span_budget_curve.transparent_rerank_topk["1"].supported, false);
assert.equal(assertionConflict.guard_calibration_curve.transparent_rerank_topk.all_guards_disabled["1"].active_assertion_conflict, false);

const unsupported = tasksByPath["procedures_and_tests[0]"];
assert.equal(unsupported.methods.exact_full_note.supported, false);
assert.equal(unsupported.methods.normalized_full_note.supported, false);
assert.equal(unsupported.methods.line_span_id.supported, false);
assert.equal(unsupported.methods.section_filtered_span.supported, false);
assert.equal(unsupported.methods.query_aware_multispan.supported, false);

assert.equal(report.summary.methods.find((item) => item.method === "exact_full_note").supported_tasks, 0);
assert.equal(report.summary.methods.find((item) => item.method === "normalized_full_note").supported_tasks, 1);
assert.equal(report.summary.methods.find((item) => item.method === "query_aware_multispan").supported_tasks, 4);

assert.equal(isStrictLowOverlapRescue(
  { prior_span_support_status: "abstain_low_overlap", miss_category: "low_overlap_possible_fabrication" },
  [{ text: "Follow-up with Dr. Cardio in two weeks." }],
  { quote_coverage: 1, label_coverage: 0.75 },
), true);
assert.equal(isStrictLowOverlapRescue(
  { prior_span_support_status: "abstain_low_overlap", miss_category: "low_overlap_possible_fabrication" },
  [{ text: "Follow-up with Dr. Cardio in two weeks." }],
  { quote_coverage: 1, label_coverage: 0.2 },
), false);
assert.equal(isStrictLowOverlapRescue(
  { prior_span_support_status: "abstain_weak_overlap", miss_category: "quote_terms_present_noncontiguous" },
  [{ text: "Follow-up with Dr. Cardio in two weeks." }],
  { quote_coverage: 1, label_coverage: 0.75 },
), false);
assert.equal(isHighRiskLabelOnlyUnion(
  [
    { section: "follow_up_safety", ordinal: 10 },
    { section: "medications", ordinal: 80 },
  ],
  { quote_coverage: 0.2, label_coverage: 0.9 },
  "query_label_multispan_supported",
), true);
assert.equal(isHighRiskLabelOnlyUnion(
  [{ section: "follow_up_safety", ordinal: 10 }],
  { quote_coverage: 0.2, label_coverage: 0.9 },
  "query_label_single_span_supported",
), false);
assert.equal(isBudgetNormalizedLabelRiskUnion(
  [
    { section: "follow_up_safety", ordinal: 1, text: "follow up" },
    { section: "follow_up_safety", ordinal: 20, text: "BMP" },
    { section: "follow_up_safety", ordinal: 40, text: "cardiology" },
    { section: "follow_up_safety", ordinal: 60, text: "visit" },
  ],
  { quote_coverage: 0.6, label_coverage: 0.9 },
  "query_label_span_budget",
), false);
assert.equal(isBudgetNormalizedLabelRiskUnion(
  [
    { section: "follow_up_safety", ordinal: 1, text: "follow up" },
    { section: "medications", ordinal: 120, text: "aspirin" },
  ],
  { quote_coverage: 0.2, label_coverage: 0.9 },
  "query_label_span_budget",
), true);
assert.equal(typeof buildSpanBudgetCurve(assertionConflict, { segments: [] }), "object");
assert.equal(typeof buildGuardCalibrationCurve(assertionConflict, { segments: [] }), "object");

console.log("PASS decomposition stress experiment (57 assertions)");
