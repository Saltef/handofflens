#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  summarizeDecompositionReports,
  renderMarkdown,
} = require("./summarize-decomposition-reports");

const summary = summarizeDecompositionReports({
  labels: ["cell-a", "cell-b"],
  stressReports: [
    stressReport({
      tasks: 5,
      sourceRecords: 2,
      exact: 0,
      normalized: 1,
      line: 2,
      section: 1,
      query: 3,
      queryContext: 12,
      queryStatuses: { query_single_span_supported: 2, abstain_query_weak: 2, query_greedy_multispan_supported: 1 },
      misses: { quote_terms_present_noncontiguous: 4, low_overlap_possible_fabrication: 1 },
    }),
    stressReport({
      tasks: 7,
      sourceRecords: 3,
      exact: 0,
      normalized: 2,
      line: 1,
      section: 1,
      query: 4,
      queryContext: 18,
      queryStatuses: { query_single_span_supported: 1, abstain_query_assertion_conflict: 1, query_greedy_multispan_supported: 3, abstain_query_weak: 2 },
      misses: { quote_terms_present_noncontiguous: 5, weak_overlap_needs_review: 2 },
    }),
  ],
  coherenceReports: [
    coherenceReport({ tasks: 5, supported: 3, unsupported: 2, auto: 2, review: 1, blocked: 0 }),
    coherenceReport({ tasks: 7, supported: 4, unsupported: 3, auto: 1, review: 3, blocked: 0 }),
  ],
});

assert.equal(summary.schema_version, "decomposition-aggregate-summary-v1");
assert.equal(summary.aggregate.tasks, 12);
assert.equal(summary.aggregate.query_aware_supported_tasks, 7);
assert.equal(summary.aggregate.normalized_supported_tasks, 3);
assert.equal(summary.aggregate.line_span_supported_tasks, 3);
assert.equal(summary.aggregate.section_filtered_supported_tasks, 2);
assert.equal(summary.aggregate.auto_accepted_supported_tasks, 3);
assert.equal(summary.aggregate.review_required_supported_tasks, 4);
assert.equal(summary.aggregate.blocked_supported_tasks, 0);
assert.equal(summary.aggregate.abstained_tasks, 5);
assert.equal(summary.aggregate.query_aware_status_counts.query_greedy_multispan_supported, 4);
assert.equal(summary.aggregate.query_aware_status_counts.abstain_query_weak, 4);
assert.equal(summary.aggregate.miss_category_counts.quote_terms_present_noncontiguous, 9);
assert.equal(summary.aggregate.query_aware_support_rate, 0.583333);
assert.equal(summary.aggregate.mean_query_context_words_supported, 15.428571);
assert.equal(summary.aggregate.mean_context_words_on_supported_items.normalized_full_note, 100);
assert.equal(summary.aggregate.mean_context_words_on_supported_items.line_span_id, 10);
assert.equal(summary.aggregate.mean_context_words_on_supported_items.section_filtered_span, 10);
assert.equal(summary.aggregate.mean_context_words_on_supported_items.query_aware_multispan, 15.428571);
assert.equal(summary.cells[0].label, "cell-a");
assert.equal(summary.cells[1].query_aware_supported_tasks, 4);

const markdown = renderMarkdown(summary);
assert.match(markdown, /Decomposition Aggregate Summary/);
assert.match(markdown, /cell-a/);
assert.match(markdown, /58\.3%/);

assert.throws(() => summarizeDecompositionReports({ stressReports: [stressReport({ tasks: 1 })], coherenceReports: [] }), /counts must match/);

console.log("PASS decomposition aggregate summary (26 assertions)");

function stressReport({
  tasks,
  sourceRecords = 1,
  exact = 0,
  normalized = 0,
  line = 0,
  section = 0,
  query = 0,
  queryContext = 0,
  queryStatuses = {},
  misses = {},
}) {
  return {
    summary: {
      tasks,
      source_records: sourceRecords,
      dominant_task_miss_categories: misses,
      methods: [
        method("exact_full_note", exact, tasks, 0),
        method("normalized_full_note", normalized, tasks, 100),
        method("line_span_id", line, tasks, 10),
        method("section_filtered_span", section, tasks, 10),
        method("query_aware_multispan", query, tasks, queryContext, queryStatuses),
      ],
    },
  };
}

function method(name, supported, tasks, contextWords, statusCounts = {}) {
  return {
    method: name,
    supported_tasks: supported,
    support_rate: tasks ? supported / tasks : 0,
    mean_selected_context_words_supported: contextWords,
    status_counts: statusCounts,
  };
}

function coherenceReport({
  tasks,
  supported,
  unsupported,
  auto,
  review,
  blocked,
}) {
  return {
    summary: {
      tasks,
      supported_tasks: supported,
      unsupported_tasks: unsupported,
      auto_accepted_supported_tasks: auto,
      review_required_supported_tasks: review,
      blocked_supported_tasks: blocked,
      high_risk_supported_tasks: blocked,
      medium_risk_supported_tasks: review,
      low_risk_supported_tasks: auto,
    },
  };
}
