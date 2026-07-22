#!/usr/bin/env node

const assert = require("node:assert/strict");
const { adaptAciBenchRows } = require("./adapt-aci-bench");
const { deriveReferenceGold } = require("./derive-reference-gold");
const { predictBenchmarkCandidates } = require("./predict-benchmark-candidates");
const { scoreBenchmarkRecords } = require("./score-benchmark-records");
const { evaluateBioScopeAssertions, parseBioScopeXml } = require("./evaluate-bioscope-assertions");
const { evaluateBioScopeConformal } = require("./evaluate-bioscope-conformal");
const { evaluateBioScopeBaselines } = require("./evaluate-bioscope-baselines");

const aci = adaptAciBenchRows([
  {
    file: "visit-1",
    src: "Doctor: Start aspirin 81 mg daily. Follow up in cardiology in one week.",
    tgt: "MEDICATION PLAN: Start aspirin 81 mg daily.\nFOLLOW-UP PLAN: Follow up in cardiology in one week.",
  },
], { split: "valid", profileId: "clinical-dialogue" });
assert.equal(aci.records[0].record_id, "visit-1");
assert.equal(aci.records[0].reference_text.includes("MEDICATION PLAN"), true);

const gold = deriveReferenceGold(aci, { maxTotal: 20, maxPerDomain: 10 });
const predictions = predictBenchmarkCandidates(aci, { maxTotal: 20, maxPerDomain: 10 });
assert.equal(gold.summary.records, 1);
assert.ok(gold.summary.gold_items >= 2);
assert.ok(predictions.records[0].predicted_items.length >= 2);
const scored = scoreBenchmarkRecords({ records: gold, predictions, bootstrapRepeats: 20 });
assert.equal(scored.summary.cases, 1);
assert.ok(scored.summary.relaxed.f1 > 0);

const xml = '<Annotation><DocumentSet><Document id="D1"><sentence id="S1">There is <xcope id="X1"><cue type="negation" ref="X1">no</cue> pneumonia</xcope>.</sentence><sentence id="S2">This <xcope id="X2"><cue type="speculation" ref="X2">may</cue> represent edema</xcope>.</sentence><sentence id="S3">The lungs are clear.</sentence></Document><Document id="D2"><sentence id="S4">No pleural effusion is seen.</sentence><sentence id="S5">This could represent atelectasis.</sentence><sentence id="S6">The heart size is normal.</sentence></Document></DocumentSet></Annotation>';
const examples = parseBioScopeXml(xml, "abstracts.xml");
assert.deepEqual(examples.slice(0, 3).map((item) => item.gold_status), ["absent", "possible", "present"]);
assert.equal(new Set(examples.map((item) => item.document_id)).size, 2);
const report = evaluateBioScopeAssertions([], { corpus: "all", examples });
assert.equal(report.summary.examples, 6);
assert.equal(report.target_mode, "sentence");
assert.ok(report.summary.macro_f1 > 0.6);
const conformal = evaluateBioScopeConformal([], { corpus: "all", examples, alpha: 0.20, calibrationFraction: 0.50, seed: "unit-test" });
assert.equal(conformal.schema_version, "bioscope-conformal-assertion-v1");
assert.equal(conformal.target_mode, "sentence");
assert.equal(conformal.split.strategy, "document_hash_split");
assert.ok(conformal.split.calibration_examples > 0);
assert.ok(conformal.split.test_examples > 0);
assert.ok(conformal.summary.empirical_coverage >= 0 && conformal.summary.empirical_coverage <= 1);
assert.ok(conformal.summary.singleton_acceptance_rate >= 0 && conformal.summary.singleton_acceptance_rate <= 1);
const baselines = evaluateBioScopeBaselines([], { corpus: "all", examples });
assert.equal(baselines.schema_version, "bioscope-baseline-comparison-v1");
assert.equal(baselines.target_mode, "sentence");
assert.ok(baselines.methods.present_majority.summary.accuracy >= 0);
assert.ok(baselines.methods.context_style.summary.macro_f1 >= baselines.methods.present_majority.summary.macro_f1);
assert.equal(baselines.comparators_not_run.length, 2);

console.log("PASS public benchmark runner checks");
