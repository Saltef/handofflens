#!/usr/bin/env node

const assert = require("node:assert/strict");
const { adaptAciBenchRows } = require("./adapt-aci-bench");
const { deriveReferenceGold } = require("./derive-reference-gold");
const { predictBenchmarkCandidates } = require("./predict-benchmark-candidates");
const { scoreBenchmarkRecords } = require("./score-benchmark-records");
const { evaluateBioScopeAssertions, parseBioScopeXml } = require("./evaluate-bioscope-assertions");

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

const xml = '<Annotation><DocumentSet><Document><sentence id="S1">There is <xcope id="X1"><cue type="negation" ref="X1">no</cue> pneumonia</xcope>.</sentence><sentence id="S2">This <xcope id="X2"><cue type="speculation" ref="X2">may</cue> represent edema</xcope>.</sentence><sentence id="S3">The lungs are clear.</sentence></Document></DocumentSet></Annotation>';
const examples = parseBioScopeXml(xml, "abstracts.xml");
assert.deepEqual(examples.map((item) => item.gold_status), ["absent", "possible", "present"]);
const report = evaluateBioScopeAssertions([], { corpus: "all", examples });
assert.equal(report.summary.examples, 3);
assert.ok(report.summary.macro_f1 > 0.6);

console.log("PASS public benchmark runner checks");