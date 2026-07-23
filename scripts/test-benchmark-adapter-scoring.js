#!/usr/bin/env node

const assert = require("node:assert/strict");
const { adaptAciBenchRows, parseCsvRows } = require("./adapt-aci-bench");
const { scoreBenchmarkRecords } = require("./score-benchmark-records");
const { scoreAciNoteGeneration, rougeN, rougeL } = require("./score-aci-note-generation");
const { scoreAciNoteFactuality } = require("./score-aci-note-factuality");
const { generateAciNoteBaselineRows } = require("./generate-aci-note-baselines");
const { evaluateAciNoteBaselines } = require("./evaluate-aci-note-baselines");
const { evaluateAciNoteAttributionRepair, repairAciNoteAttributionRows } = require("./repair-aci-note-attribution");

const csvRows = parseCsvRows('id,dialogue,note\n"case-1","Doctor: Start aspirin. Follow up in one week.","Start aspirin; follow up in one week."\n');
assert.equal(csvRows.length, 2);
assert.equal(csvRows[1][1], "Doctor: Start aspirin. Follow up in one week.");

const adapted = adaptAciBenchRows([
  {
    id: "aci-synth-001",
    dialogue: "Doctor: Start aspirin 81 mg daily. Follow up with cardiology in one week.",
    note: "Aspirin 81 mg daily started. Cardiology follow-up in one week.",
    gold_items: [
      { item_id: "g1", domain: "medication_changes.started", label: "aspirin 81 mg daily", source_quote: "Start aspirin 81 mg daily" },
      { item_id: "g2", domain: "follow_up_actions", label: "cardiology follow up in one week", source_quote: "Follow up with cardiology in one week" },
    ],
  },
  {
    id: "aci-synth-002",
    dialogue: "Doctor: The potassium was low and was replaced.",
    note: "Hypokalemia was treated.",
    gold_items: [
      { item_id: "g3", domain: "labs", label: "low potassium", source_quote: "potassium was low" },
    ],
  },
], { split: "dev", profileId: "clinical-dialogue" });

assert.equal(adapted.summary.records_emitted, 2);
assert.equal(adapted.summary.records_with_reference_text, 2);
assert.equal(adapted.summary.records_with_gold_items, 2);
assert.equal(adapted.records[0].metadata.profile_id, "clinical-dialogue");

const predictions = {
  records: [
    {
      record_id: "aci-synth-001",
      predicted_items: [
        { item_id: "p1", domain: "medication_changes.started", label: "aspirin 81 mg daily", source_quote: "Start aspirin 81 mg daily" },
        { item_id: "p2", domain: "follow_up_actions", label: "cardiology follow-up one week", source_quote: "Follow up with cardiology in one week" },
        { item_id: "p3", domain: "diagnosis_changes", label: "heart failure", source_quote: "heart failure" },
      ],
    },
    {
      record_id: "aci-synth-002",
      predicted_items: [
        { item_id: "p4", domain: "labs", label: "hypokalemia", source_quote: "potassium was low" },
      ],
    },
  ],
};

const report = scoreBenchmarkRecords({ records: adapted, predictions, bootstrapRepeats: 100 });
assert.equal(report.summary.cases, 2);
assert.equal(report.summary.exact.true_positives, 1);
assert.equal(report.summary.exact.false_positives, 3);
assert.equal(report.summary.exact.false_negatives, 2);
assert.equal(report.summary.relaxed.true_positives, 3);
assert.equal(report.summary.relaxed.false_positives, 1);
assert.equal(report.summary.relaxed.false_negatives, 0);
assert.ok(report.summary.relaxed.f1 > report.summary.exact.f1);
assert.ok(Array.isArray(report.summary.relaxed.precision_ci95));
assert.ok(Array.isArray(report.summary.relaxed.f1_bootstrap_ci95));
assert.equal(report.by_domain.follow_up.relaxed.true_positives, 1);

const unscored = scoreBenchmarkRecords({ records: { records: [{ record_id: "no-gold", source_text: "x", gold_items: [] }] }, predictions: { records: [] } });
assert.equal(unscored.summary.cases, 0);
assert.match(unscored.interpretation, /No scored cases/);

const rougeOne = rougeN("start aspirin today", "start aspirin daily", 1);
assert.equal(rougeOne.precision, 2 / 3);
assert.equal(rougeOne.recall, 2 / 3);
const rougeLongest = rougeL("start aspirin today", "start aspirin daily");
assert.equal(rougeLongest.f1, 2 / 3);
const noteScore = scoreAciNoteGeneration([
  { file: "n1", src: "Doctor: Start aspirin today.", tgt: "Start aspirin today." },
  { file: "n2", src: "Doctor: Follow up next week.", tgt: "Follow up next week." },
], { split: "unit", predictionField: "src", bootstrapRepeats: 20 });
assert.equal(noteScore.summary.cases, 2);
assert.ok(noteScore.summary.metrics.rouge1.f1 > 0.75);
assert.ok(Array.isArray(noteScore.summary.metrics.rougeL.f1_bootstrap_ci95));

const generated = generateAciNoteBaselineRows([
  {
    record_id: "g1",
    source_text: "Doctor: Start aspirin today. Doctor: Follow up next week. Patient: Thank you.",
    reference_text: "Start aspirin today. Follow up next week.",
  },
], { method: "cue_sentence_extractive", predictionField: "generated_note" });
assert.equal(generated.records.length, 1);
assert.match(generated.records[0].generated_note, /Start aspirin/);
const factuality = scoreAciNoteFactuality(generated.records, { split: "unit", predictionField: "generated_note" });
assert.equal(factuality.summary.cases, 1);
assert.equal(factuality.summary.mean_source_token_support_rate, 1);
const noteBaselines = evaluateAciNoteBaselines(generated.records, { split: "unit", methods: ["source_full", "tail_reference_length"], bootstrapRepeats: 20 });
assert.equal(noteBaselines.schema_version, "aci-note-baseline-comparison-v1");
assert.equal(noteBaselines.ranking.length, 2);
assert.ok(noteBaselines.selected_method);

const unsupportedGenerationRows = [
  {
    record_id: "repair-1",
    source_text: [
      "Doctor: Chest pain has resolved.",
      "Doctor: Start aspirin 81 mg daily.",
      "Doctor: Check potassium and creatinine in 3 days.",
      "Patient: I am not taking warfarin.",
    ].join(" "),
    reference_text: "Chest pain has resolved. Start aspirin 81 mg daily. Check potassium and creatinine in 3 days.",
    generated_note: "Chest pain has resolved. Start aspirin 81 mg daily. Start warfarin 5 mg nightly. Check potassium and creatinine in 3 days.",
  },
];
const repaired = repairAciNoteAttributionRows(unsupportedGenerationRows, {
  method: "guided_extractive",
  minOverlap: 0.28,
});
assert.doesNotMatch(repaired[0].repaired_note, /Start warfarin 5 mg nightly/);
assert.match(repaired[0].repaired_note, /Start aspirin 81 mg daily/);
assert.match(repaired[0].repaired_note, /Check potassium and creatinine in 3 days/);
assert.ok(repaired[0].attribution_repair.dropped_sentence_count >= 1);

const beforeRepairSupport = scoreAciNoteFactuality(unsupportedGenerationRows, { split: "unit", predictionField: "generated_note" }).summary;
const afterRepairSupport = scoreAciNoteFactuality(repaired, { split: "unit", predictionField: "repaired_note" }).summary;
assert.ok(afterRepairSupport.mean_source_token_support_rate > beforeRepairSupport.mean_source_token_support_rate);
assert.equal(afterRepairSupport.cases, 1);

const repairReport = evaluateAciNoteAttributionRepair(unsupportedGenerationRows, {
  split: "unit",
  methods: "drop_unsupported,replace_unsupported,compact_extractive,guided_extractive",
  bootstrapRepeats: 20,
});
assert.equal(repairReport.schema_version, "aci-note-attribution-repair-v1");
assert.equal(repairReport.ranking.length, 4);
assert.ok(repairReport.ranking.every((item) => item.scored_case_rate === 1));
assert.ok(repairReport.selected_method);
assert.ok(repairReport.ranking.every((item) => Number.isFinite(item.rougeL_retention_rate)));
assert.ok(repairReport.methods.compact_extractive.summary.tradeoff.rougeL_retention_rate > 0);
assert.ok(repairReport.methods.compact_extractive.summary.tradeoff.unsupported_sentence_case_rate_reduction >= 0);
assert.match(repairReport.methods.compact_extractive.summary.tradeoff.caveat, /lexical source support expected/);

console.log("PASS benchmark adapter and scoring checks (46 assertions)");
