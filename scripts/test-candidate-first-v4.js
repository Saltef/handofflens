#!/usr/bin/env node
const assert = require("node:assert/strict");
const { canonicalizeWithMap, generateCandidates } = require("./candidate-first-index");

const source = "DISCHARGE MEDICATIONS:\n1. Aspirin 81 mg daily.\n2. Prednisone taper from 60 mg to 20 mg.\n\nDISCHARGE DIAGNOSES:\n1. Pneumonia.\n\nFOLLOW-UP:\nClinic in one week.";
const variants = [source, source.replace(/\n/g, "   \n"), source.replace(/\s+/g, " ")];
const indexes = variants.map((value) => generateCandidates(value));
assert.equal(canonicalizeWithMap(source).text, canonicalizeWithMap(variants[2]).text);
assert.ok(indexes[0].candidates.length >= 4);
assert.deepEqual(indexes[0].candidates.map((x) => x.candidate_id), indexes[1].candidates.map((x) => x.candidate_id));
assert.deepEqual(indexes[0].candidates.map((x) => x.candidate_id), indexes[2].candidates.map((x) => x.candidate_id));
assert.equal(indexes[0].detected_domains.medication_changes, true);
assert.equal(indexes[0].detected_domains.diagnosis_changes, true);
assert.equal(indexes[0].detected_domains.follow_up_actions, true);
for (const candidate of indexes[0].candidates) assert.equal(source.slice(candidate.original_start, candidate.original_end), candidate.source_quote);
assert.equal(indexes[0].overflow.count, 0);
const bullets = generateCandidates("DISCHARGE INSTRUCTIONS:\n?????? Increase fluids and fiber. Take Docusate while taking narcotics.\n?????? Do not take aspirin.");
const stool = bullets.candidates.find((x) => x.canonical_text.includes("Increase fluids"));
assert.ok(stool.canonical_text.includes("Take Docusate"));
assert.ok(!stool.canonical_text.includes("Do not take aspirin"));
assert.ok(!stool.source_quote.includes("??????"));
console.log("PASS candidate-first v4 stable indexing and provenance (9 checks)");
