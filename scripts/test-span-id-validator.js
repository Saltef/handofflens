#!/usr/bin/env node

const assert = require("node:assert/strict");
const { buildSpanIndex } = require("./span-index");
const {
  validateSpanIdEvidenceItem,
  validateSpanIdExtraction,
  enforceSpanIdValidationPolicy,
} = require("./span-id-validator");

const index = buildSpanIndex("MEDICATIONS: Started on metformin 500 mg BID.\nNo pneumonia was seen.", { granularity: "clause" });

const valid = {
  field: "medication",
  evidence_span_ids: ["S1"],
  surface_form: { span_id: "S1", token_start: 2, token_end: 5 },
  normalized_value: "metformin 500 mg BID",
  assertion: "present",
  support_status: "supported",
};

assert.equal(validateSpanIdEvidenceItem(valid, index).valid, true);

const unknown = validateSpanIdEvidenceItem({ ...valid, evidence_span_ids: ["S999"] }, index);
assert.equal(unknown.valid, false);
assert.equal(unknown.errors[0].code, "unknown_span_id");

const emptySupported = validateSpanIdEvidenceItem({ ...valid, evidence_span_ids: [] }, index);
assert.equal(emptySupported.valid, false);
assert.equal(emptySupported.errors[0].code, "empty_supported_span_ids");

const abstained = validateSpanIdEvidenceItem({
  field: "diagnosis",
  evidence_span_ids: [],
  normalized_value: "pneumonia",
  assertion: "absent",
  support_status: "not_found",
}, index);
assert.equal(abstained.valid, true);

const overCap = validateSpanIdEvidenceItem({ ...valid, evidence_span_ids: ["S1", "S2", "S3", "S4"] }, index);
assert.equal(overCap.valid, false);
assert.equal(overCap.errors.some((error) => error.code === "too_many_span_ids"), true);

const badSurface = validateSpanIdEvidenceItem({ ...valid, surface_form: { span_id: "S1", token_start: 8, token_end: 9 } }, index);
assert.equal(badSurface.valid, false);
assert.equal(badSurface.errors[0].code, "surface_offsets_out_of_range");

const retry = enforceSpanIdValidationPolicy({ ...valid, evidence_span_ids: ["S404"] }, index, { retryCount: 1, maxRetries: 2 });
assert.equal(retry.retry_required, true);
assert.equal(retry.exhausted, false);

const exhausted = enforceSpanIdValidationPolicy({ ...valid, evidence_span_ids: ["S404"] }, index, { retryCount: 2, maxRetries: 2 });
assert.equal(exhausted.retry_required, false);
assert.equal(exhausted.exhausted, true);
assert.equal(exhausted.item.support_status, "not_found");
assert.deepEqual(exhausted.item.evidence_span_ids, []);
assert.equal(exhausted.validation.valid, true);

const extraction = {
  medication_changes: { started: [valid], stopped: [], changed: [], continued: [], uncertain: [] },
  diagnosis_changes: { discharge: [{ ...valid, field: "diagnosis", evidence_span_ids: ["S2"], assertion: "absent" }], new_or_changed: [] },
  procedures_and_tests: [],
  labs: [],
  follow_up_actions: [],
  safety_flags: [],
  uncertain_items: [],
};
const extractionResult = validateSpanIdExtraction(extraction, index);
assert.equal(extractionResult.valid, true);
assert.equal(extractionResult.item_count, 2);
assert.equal(extractionResult.invalid_item_count, 0);

console.log("PASS span-ID validator (17 assertions)");
