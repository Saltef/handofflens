#!/usr/bin/env node

const assert = require("node:assert/strict");
const { buildSpanIndex } = require("./span-index");
const {
  buildOutputSchema,
  toCohereCompatibleSchema,
  scoreAblationRecord,
  summarizeAblation,
  summarizeVolumeNormalizedComparisons,
  updatePublicSummary,
} = require("./evaluate-span-id-v5-ablation");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sourceText = [
  "DISCHARGE MEDICATIONS: Metformin 500 mg twice daily.",
  "FOLLOW-UP: Check potassium and creatinine in 3 days.",
  "Return for weight gain above 2 kg.",
].join("\n");
const testCase = {
  case_id: "SYNTH_SPAN_V5",
  age: "70",
  gender: "F",
  admission_diagnosis: "heart failure",
  discharge_summary: sourceText,
};
const spanIndex = buildSpanIndex(sourceText, { granularity: "clause" });

const spanSchema = buildOutputSchema({ arm: "span_id_v5", spanIds: ["S1", "S2"] });
assert.deepEqual(spanSchema.properties.items.items.properties.evidence_span_ids.items.enum, ["S1", "S2"]);
assert.equal(spanSchema.properties.items.items.properties.evidence_span_ids.maxItems, 3);
assert.equal(spanSchema.properties.items.items.required.includes("source_quote"), false);
assert.equal(spanSchema.properties.items.items.required.includes("evidence_span_ids"), true);
const cohereSpanSchema = toCohereCompatibleSchema(spanSchema);
assert.equal(JSON.stringify(cohereSpanSchema).includes("maxItems"), false);
assert.deepEqual(cohereSpanSchema.properties.items.items.properties.evidence_span_ids.items.enum, ["S1", "S2"]);

const quoteSchema = buildOutputSchema({ arm: "quote_v2", spanIds: ["S1", "S2"] });
assert.equal(quoteSchema.properties.items.items.required.includes("source_quote"), true);
assert.equal("evidence_span_ids" in quoteSchema.properties.items.items.properties, false);

const quoteRecord = scoreAblationRecord({
  execution_index: 0,
  model: "cohere-aplus:command-a-plus-05-2026",
  arm: "quote_v2",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "follow_up",
      normalized_value: "check potassium and creatinine in 3 days",
      assertion: "present",
      support_status: "supported",
      source_quote: "Check potassium and creatinine in 3 days.",
    }],
  },
});
assert.equal(quoteRecord.scoring.exact_quote_support_rate.numerator, 1);
assert.equal(quoteRecord.scoring.case_gate_passed, true);

const minimalQuoteRecord = scoreAblationRecord({
  execution_index: 1,
  model: "cohere-aplus:command-a-plus-05-2026",
  arm: "quote_v2_minimal",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "safety",
      normalized_value: "return for weight gain above 2 kg",
      assertion: "present",
      support_status: "supported",
      source_quote: "Return for weight gain above 2 kg.",
    }],
  },
});
assert.equal(minimalQuoteRecord.scoring.selector_support_rate.numerator, 1);
assert.equal(minimalQuoteRecord.scoring.scored_items[0].selector_span_ids.length, 1);

const spanRecord = scoreAblationRecord({
  execution_index: 2,
  model: "anthropic/claude-haiku-4.5",
  arm: "span_id_v5",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "medication",
      normalized_value: "metformin 500 mg twice daily",
      assertion: "present",
      support_status: "supported",
      evidence_span_ids: ["S1"],
      entailment_scored: false,
      entailment_score: null,
    }],
  },
});
assert.equal(spanRecord.scoring.span_validity_rate.numerator, 1);
assert.equal(spanRecord.scoring.item_support_rate.numerator, 1);

const invalidSpanRecord = scoreAblationRecord({
  execution_index: 3,
  model: "anthropic/claude-haiku-4.5",
  arm: "span_id_v5",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "lab",
      normalized_value: "missing lab",
      assertion: "present",
      support_status: "supported",
      evidence_span_ids: ["S404"],
      entailment_scored: false,
      entailment_score: null,
    }],
  },
});
assert.equal(invalidSpanRecord.scoring.span_validity_rate.numerator, 0);
assert.equal(invalidSpanRecord.scoring.item_support_rate.numerator, 0);
assert.equal(invalidSpanRecord.scoring.validation_error_counts.unknown_span_id, 1);

const summary = summarizeAblation([quoteRecord, minimalQuoteRecord, spanRecord, invalidSpanRecord]);
assert.equal(summary["cohere-aplus:command-a-plus-05-2026||quote_v2"].item_support_rate.numerator, 1);
assert.equal(summary["cohere-aplus:command-a-plus-05-2026||quote_v2_minimal"].selector_support_rate.numerator, 1);
assert.equal(summary["anthropic/claude-haiku-4.5||span_id_v5"].runs, 2);
assert.equal(summary["anthropic/claude-haiku-4.5||span_id_v5"].span_validity_rate.denominator, 2);

const pairedQuoteRecord = scoreAblationRecord({
  execution_index: 4,
  model: "anthropic/claude-haiku-4.5",
  arm: "quote_v2",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "follow_up",
      normalized_value: "check potassium and creatinine in 3 days",
      assertion: "present",
      support_status: "supported",
      source_quote: "Check potassium and creatinine in 3 days.",
    }],
  },
});
const pairedSpanRecord = scoreAblationRecord({
  execution_index: 5,
  model: "anthropic/claude-haiku-4.5",
  arm: "span_id_v5",
  repeat: 1,
  testCase,
  spanIndex,
  telemetry: {},
  request_started_at: "2026-08-08T00:00:00.000Z",
  latency_ms: 1,
  extraction: {
    case_id: testCase.case_id,
    abstention_reason: "",
    items: [{
      field: "follow_up",
      normalized_value: "check potassium and creatinine in 3 days",
      assertion: "present",
      support_status: "supported",
      evidence_span_ids: ["S2"],
      entailment_scored: false,
      entailment_score: null,
    }, {
      field: "lab",
      normalized_value: "unsupported calcium recheck",
      assertion: "present",
      support_status: "supported",
      evidence_span_ids: ["S404"],
      entailment_scored: false,
      entailment_score: null,
    }],
  },
});
const volumeComparisons = summarizeVolumeNormalizedComparisons([pairedQuoteRecord, pairedSpanRecord]);
const comparisonKey = "anthropic/claude-haiku-4.5||span_id_v5_vs_quote_v2";
assert.equal(volumeComparisons[comparisonKey].paired_runs, 1);
assert.equal(volumeComparisons[comparisonKey].matched_item_count, 1);
assert.equal(volumeComparisons[comparisonKey].comparison_case_gate_at_matched_count.numerator, 1);
assert.equal(volumeComparisons[comparisonKey].comparison_raw_case_gate_rate.numerator, 0);
assert.equal(volumeComparisons[comparisonKey].comparison_prefix_pass_raw_fail_count, 1);

const tmpSummary = path.join(os.tmpdir(), `handofflens-public-summary-${Date.now()}.json`);
fs.writeFileSync(tmpSummary, `${JSON.stringify({ schema_ablation: { remaining_ablation_work: "stale" } }, null, 2)}\n`);
updatePublicSummary(tmpSummary, {
  experiment_id: "span-id-v5-cross-provider-ablation",
  results: [quoteRecord, minimalQuoteRecord, spanRecord, invalidSpanRecord],
  cases: ["SYNTH_SPAN_V5"],
  models: ["cohere-aplus:command-a-plus-05-2026", "anthropic/claude-haiku-4.5"],
  arms: ["quote_v2", "quote_v2_minimal", "span_id_v5"],
  repeats: 1,
  routes: { primary: "json_schema" },
  telemetry_policy: { raw_logits_available_from_hosted_chat_api: false },
  claims_boundary: "Automated auditability evidence only; span-ID validity is by construction and does not prove semantic entailment.",
  summary,
  volume_normalized_comparisons: volumeComparisons,
});
const regeneratedSummary = JSON.parse(fs.readFileSync(tmpSummary, "utf8"));
assert.equal("remaining_ablation_work" in regeneratedSummary.schema_ablation, false);
assert.equal(regeneratedSummary.schema_ablation.completed_ablation_work.includes("three repeats"), true);
assert.equal(regeneratedSummary.schema_ablation.volume_normalized_comparisons[comparisonKey].comparison_prefix_pass_raw_fail_count, 1);
fs.unlinkSync(tmpSummary);

console.log("PASS span-ID v5 ablation (30 assertions)");
