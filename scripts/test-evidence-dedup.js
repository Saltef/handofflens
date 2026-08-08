#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  dedupeEvidenceInPlace,
  nearDuplicateEvidence,
} = require("./evidence-dedup");

let assertions = 0;
function check(value, expected, message) {
  assert.deepEqual(value, expected, message);
  assertions += 1;
}

check(nearDuplicateEvidence(
  { label: "Amlodipine 5 mg daily", source_quote: "Amlodipine 5 mg daily." },
  { label: "Amlodipine 5 mg daily", source_quote: "Amlodipine 5 mg daily." },
), true, "exact label and quote should match");

check(nearDuplicateEvidence(
  { label: "Aspirin 81 mg continued", source_quote: "Discharge medications: aspirin 81 mg daily." },
  { label: "Aspirin daily", source_quote: "Discharge medications: aspirin 81 mg daily." },
), true, "same source quote with overlapping label should match");

check(nearDuplicateEvidence(
  { label: "Creatinine 1.3 mg/dL on discharge", source_quote: "Renal function: creatinine was 1.3 mg/dL on discharge." },
  { label: "Creatinine 1.3", source_quote: "creatinine was 1.3 mg/dL on discharge" },
), true, "contained quote with overlapping label should match");

check(nearDuplicateEvidence(
  { label: "Aspirin 81 mg continued", source_quote: "Discharge medications: aspirin 81 mg daily." },
  { label: "Metoprolol started", source_quote: "Start metoprolol succinate 25 mg daily." },
), false, "different medication facts should not match");

check(nearDuplicateEvidence(
  { label: "Weight gain over 2 kg", source_quote: "Call for weight gain above 2 kg in 3 days." },
  { label: "Creatinine repeat in 3 days", source_quote: "Repeat potassium and creatinine in 3 days." },
), false, "shared timing words alone should not match");

const list = [
  { label: "Amlodipine 5 mg daily", source_quote: "Amlodipine 5 mg daily." },
  { label: "Amlodipine 5 mg daily", source_quote: "Amlodipine 5 mg daily." },
  { label: "Aspirin 81 mg continued", source_quote: "Discharge medications: aspirin 81 mg daily." },
  { label: "Aspirin daily", source_quote: "Discharge medications: aspirin 81 mg daily." },
  { label: "Metoprolol started", source_quote: "Start metoprolol succinate 25 mg daily." },
];
const audit = dedupeEvidenceInPlace(list);
check(audit.removed_items, 2, "two duplicate items should be removed");
check(list.map((item) => item.label), [
  "Amlodipine 5 mg daily",
  "Aspirin 81 mg continued",
  "Metoprolol started",
], "dedupe should keep first representative from each near-duplicate group");
check(audit.groups.map((group) => group.reason), [
  "same_source_quote",
  "same_source_quote",
], "audit should preserve merge reasons");

console.log(`PASS evidence deduplication (${assertions} assertions)`);
