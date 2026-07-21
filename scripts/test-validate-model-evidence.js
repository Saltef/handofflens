#!/usr/bin/env node

const assert = require("node:assert/strict");
const { validateModelEvidence } = require("./validate-model-evidence");

const validPayload = {
  summary: {
    "cohere-aplus:command-a-plus-05-2026": {
      cases_attempted: 1,
      cases_completed: 1,
      failures: 0,
      cases_scored: 1,
    },
  },
  results: [
    {
      provider: "cohere",
      model: "cohere-aplus:command-a-plus-05-2026",
      route_model: "cohere-json-schema:command-a-plus-05-2026",
      case_id: "SYNTH_001",
      extraction: { two_page_summary: "Source-grounded summary." },
      raw_schema_valid: true,
      schema_repairs: [],
      attempt_audit: [
        {
          attempt: 1,
          route_model: "cohere-json-schema:command-a-plus-05-2026",
          status: "success",
        },
      ],
      score: { overall: { f1: 1 } },
    },
  ],
};

const valid = validateModelEvidence(validPayload, {
  requireProvider: "cohere",
  requireScored: true,
});

assert.equal(valid.valid, true);
assert.equal(valid.summary.completed_rows, 1);
assert.equal(valid.summary.provider_error_rows, 0);
assert.equal(valid.summary.scored_rows, 1);

const missingKeyPayload = {
  summary: {
    "cohere-aplus:command-a-plus-05-2026": {
      cases_attempted: 1,
      cases_completed: 0,
      failures: 1,
      cases_scored: 0,
    },
  },
  results: [
    {
      provider: "cohere",
      model: "cohere-aplus:command-a-plus-05-2026",
      route_model: "cohere-json-schema:command-a-plus-05-2026",
      case_id: "SYNTH_001",
      error: "Missing COHERE_API_KEY",
      attempt_audit: [
        {
          attempt: 1,
          route_model: "cohere-json-schema:command-a-plus-05-2026",
          status: "failure",
          error: "Missing COHERE_API_KEY",
        },
      ],
      score: { overall: { f1: 0 } },
    },
  ],
};

const missingKey = validateModelEvidence(missingKeyPayload, {
  requireProvider: "cohere",
  requireScored: true,
});

assert.equal(missingKey.valid, false);
assert.equal(missingKey.summary.failed_rows, 1);
assert.equal(missingKey.summary.provider_error_rows, 1);
assert.equal(missingKey.issues.some((issue) => issue.code === "provider_error"), true);
assert.equal(missingKey.issues.some((issue) => issue.code === "incomplete_cases"), true);

const repaired = structuredClone(validPayload);
repaired.results[0].raw_schema_valid = false;
repaired.results[0].schema_repairs = [{ path: "two_page_summary", action: "coerce" }];

assert.equal(validateModelEvidence(repaired, { requireProvider: "cohere" }).valid, false);
assert.equal(validateModelEvidence(repaired, { requireProvider: "cohere", allowRepairs: true }).valid, true);

console.log("PASS model evidence validity checker (13 assertions)");
