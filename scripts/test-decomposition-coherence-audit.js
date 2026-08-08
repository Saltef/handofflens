#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  auditDecompositionCoherence,
  hasAssertionCueConflict,
} = require("./audit-decomposition-coherence");

assert.equal(hasAssertionCueConflict("No pneumonia was seen.", "Pneumonia"), true);
assert.equal(hasAssertionCueConflict("No pneumonia was seen.", "No pneumonia"), false);
assert.equal(hasAssertionCueConflict("Cannot exclude abscess.", "Abscess"), true);
assert.equal(hasAssertionCueConflict("Cannot exclude abscess.", "Possible abscess"), false);
assert.equal(hasAssertionCueConflict("In MICU, did EGD which showed erosions, but no active bleed.", "EGD upper endoscopy", { domain: "procedure_or_test" }), false);
assert.equal(hasAssertionCueConflict("Cardiac catheterization completed without complication.", "Cardiac catheterization completed", { domain: "procedure_or_test" }), false);
assert.equal(hasAssertionCueConflict("A blood culture was no growth.", "Blood culture for sepsis evaluation", { domain: "procedure_or_test" }), false);
assert.equal(hasAssertionCueConflict("Please do not stop your Amoxicillin.", "Antibiotic completion", { domain: "safety" }), false);
assert.equal(hasAssertionCueConflict("Culture showed no MRSA growth.", "MRSA growth", { domain: "lab" }), true);

const payload = {
  tasks: [
    task({
      path: "labs[0]",
      status: "query_greedy_multispan_supported",
      spans: [
        span("L0004", "labs", "Creatinine 1.3 mg/dL.", 0.5, 0.5),
        span("L0005", "labs", "Potassium 4.9 mmol/L.", 0.5, 0.5),
      ],
      quote: 1,
      label: 1,
    }),
    task({
      path: "diagnosis_changes.discharge[0]",
      status: "query_greedy_multispan_supported",
      spans: [
        span("L0002", "diagnoses", "Heart failure exacerbation.", 0.5, 0.5),
        span("L0088", "follow_up_safety", "Cardiology follow-up requested.", 0.5, 0.5),
      ],
      quote: 0.9,
      label: 0.9,
    }),
    task({
      path: "procedures_and_tests[0]",
      miss: "low_overlap_possible_fabrication",
      prior: "abstain_low_overlap",
      status: "query_label_single_span_supported",
      spans: [span("L0006", "procedures_tests", "Stress test outpatient.", 0.1, 1)],
      quote: 0.1,
      label: 1,
    }),
    task({
      path: "diagnosis_changes.new_or_changed[0]",
      status: "query_single_span_supported",
      spans: [span("L0008", "diagnoses", "No pneumonia was seen.", 1, 1)],
      quote: 1,
      label: 1,
      labelText: "Pneumonia",
    }),
    task({
      path: "follow_up_actions[0]",
      supported: false,
      status: "abstain_query_weak",
      spans: [],
      quote: 0.2,
      label: 0.2,
    }),
  ],
};

const report = auditDecompositionCoherence(payload, {
  contextWordWarning: 20,
  lineWindowWarning: 40,
});

assert.equal(report.summary.tasks, 5);
assert.equal(report.summary.supported_tasks, 4);
assert.equal(report.summary.unsupported_tasks, 1);
assert.equal(report.summary.low_risk_supported_tasks, 1);
assert.equal(report.summary.medium_risk_supported_tasks, 1);
assert.equal(report.summary.high_risk_supported_tasks, 2);
assert.equal(report.summary.auto_accepted_supported_tasks, 1);
assert.equal(report.summary.review_required_supported_tasks, 1);
assert.equal(report.summary.blocked_supported_tasks, 2);
assert.equal(report.summary.low_overlap_supported_tasks, 1);
assert.equal(report.summary.assertion_cue_conflict_tasks, 1);
assert.equal(report.summary.cross_section_supported_tasks, 1);
assert.equal(report.summary.wide_window_supported_tasks, 1);

const byPath = Object.fromEntries(report.tasks.map((item) => [item.path, item]));
assert.equal(byPath["labs[0]"].risk_level, "low");
assert.equal(byPath["labs[0]"].acceptance, "auto_accept");
assert.equal(byPath["diagnosis_changes.discharge[0]"].risk_level, "medium");
assert.equal(byPath["diagnosis_changes.discharge[0]"].acceptance, "review_required");
assert.equal(byPath["procedures_and_tests[0]"].risk_level, "high");
assert.equal(byPath["procedures_and_tests[0]"].acceptance, "blocked_review");
assert.equal(byPath["diagnosis_changes.new_or_changed[0]"].risk_level, "high");
assert.equal(byPath["diagnosis_changes.new_or_changed[0]"].acceptance, "blocked_review");
assert.equal(byPath["follow_up_actions[0]"].risk_level, "not_supported");
assert.equal(byPath["follow_up_actions[0]"].acceptance, "abstain");

console.log("PASS decomposition coherence audit (35 assertions)");

function task({
  path,
  domain = "lab",
  miss = "quote_terms_present_noncontiguous",
  prior = "abstain_weak_overlap",
  supported = true,
  status,
  spans,
  quote,
  label,
  labelText = "Creatinine and potassium",
}) {
  return {
    case_id: "coherence-fixture",
    path,
    domain,
    miss_category: miss,
    prior_span_support_status: prior,
    label: labelText,
    methods: {
      query_aware_multispan: {
        supported,
        status,
        selected_span_count: spans.length,
        selected_context_words: spans.map((spanItem) => spanItem.text).join(" ").split(/\s+/).filter(Boolean).length,
        selected_spans: spans,
        combined_quote_coverage: quote,
        combined_label_coverage: label,
      },
    },
  };
}

function span(spanId, section, text, quoteCoverage, labelCoverage) {
  return {
    span_id: spanId,
    section,
    text,
    quote_coverage: quoteCoverage,
    label_coverage: labelCoverage,
    score: Math.max(quoteCoverage, labelCoverage),
  };
}
