"use strict";

// Regression guard for the hosted structured-output compatibility layer.
//
// Finding under test (see docs/claims-register.md, Phase 4 + the Cohere-facing
// cardinality best practice): the hosted-schema compatibility path strips local
// JSON Schema *cardinality/format* constraints before provider submission, while
// preserving `enum`. That single asymmetry is the mechanism behind the span-ID
// results: `enum` is kept -> span IDs resolve 100%; `maxItems` is dropped ->
// models can emit more than the local 3-span cap (703 Haiku / 130 Cohere
// too-many-span violations in the frozen ablation).
//
// This test pins that behavior so it cannot change silently. It is fully
// offline: no provider calls, no keys, no spend.

const assert = require("node:assert");
const {
  buildOutputSchema,
  toCohereCompatibleSchema,
} = require("./evaluate-span-id-v5-ablation");

// Keywords the compat layer is expected to strip everywhere.
const EXPECTED_STRIPPED = [
  "maxItems",
  "minItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "uniqueItems",
];

// Keywords the compat layer is expected to preserve (these carry the contract
// that still works end-to-end, e.g. the span-ID enum).
const EXPECTED_PRESERVED = ["enum", "const", "required", "additionalProperties", "type"];

function collectKeywords(node, found = new Set()) {
  if (Array.isArray(node)) {
    node.forEach((child) => collectKeywords(child, found));
    return found;
  }
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    collectKeywords(value, found);
  }
  return found;
}

// A synthetic schema carrying every keyword the compat layer should strip, plus
// an `enum` it should keep. This guards the strip-set directly, independent of
// which keywords the real ablation schema happens to use.
function syntheticProbeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: {
      a: {
        type: "array",
        maxItems: 3,
        minItems: 1,
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["x", "y"],
          minLength: 1,
          maxLength: 10,
          pattern: "^[a-z]+$",
        },
      },
      b: { type: "integer", minimum: 0, maximum: 99 },
    },
  };
}

function run() {
  const failures = [];

  // 1. Strip-set contract: build a schema containing all stripped keywords and
  //    assert each is removed while `enum` survives.
  const probeRaw = syntheticProbeSchema();
  const probeOut = toCohereCompatibleSchema(probeRaw);
  const probeRawKw = collectKeywords(probeRaw);
  const probeOutKw = collectKeywords(probeOut);
  for (const kw of EXPECTED_STRIPPED) {
    if (!probeRawKw.has(kw)) {
      failures.push(`test bug: synthetic probe is missing "${kw}" — cannot guard it`);
    } else if (probeOutKw.has(kw)) {
      failures.push(`LEAK: "${kw}" survived the compat layer (should be stripped)`);
    }
  }
  for (const kw of EXPECTED_PRESERVED) {
    if (probeRawKw.has(kw) && !probeOutKw.has(kw)) {
      failures.push(`DROPPED: "${kw}" was removed by the compat layer (should be preserved)`);
    }
  }

  // 2. Real span_id_v5 schema, enum branch (spanIds present).
  const spanIds = ["S1", "S2", "S3", "S4", "S5"];
  const rawSchema = buildOutputSchema({ arm: "span_id_v5", spanIds });
  const submitted = toCohereCompatibleSchema(rawSchema);
  const submittedKeywords = collectKeywords(submitted);

  // 2b. Real span_id_v5 schema, pattern branch (spanIds empty) — exercises the
  //     one stripped keyword the enum branch does not use.
  const patternBranch = toCohereCompatibleSchema(buildOutputSchema({ arm: "span_id_v5", spanIds: [] }));
  if (collectKeywords(patternBranch).has("pattern")) {
    failures.push('LEAK: "pattern" survived the compat layer on the empty-spanIds branch');
  }

  // 3. The specific causal facts, asserted directly on the structure so a
  //    reader sees exactly what the ablation depends on.
  const rawSpanIds = rawSchema.properties.items.items.properties.evidence_span_ids;
  const submittedSpanIds = submitted.properties.items.items.properties.evidence_span_ids;

  try {
    assert.strictEqual(rawSpanIds.maxItems, 3, "raw evidence_span_ids cap should be 3");
    assert.strictEqual(
      submittedSpanIds.maxItems,
      undefined,
      "MECHANISM: evidence_span_ids.maxItems (the 3-span cap) must be stripped before submission",
    );
    assert.deepStrictEqual(
      submittedSpanIds.items.enum,
      spanIds,
      "MECHANISM: evidence_span_ids.items.enum (the resolvable-ID contract) must be preserved",
    );
    assert.strictEqual(
      submitted.properties.items.maxItems,
      undefined,
      "items.maxItems (the 80-item cap) must be stripped before submission",
    );
  } catch (error) {
    failures.push(`assertion: ${error.message}`);
  }

  const asymmetry = {
    "evidence_span_ids.maxItems (cap)": `${rawSpanIds.maxItems} -> ${submittedSpanIds.maxItems}`,
    "evidence_span_ids.items.enum (resolvability)": `[${(submittedSpanIds.items.enum || []).join(",")}]`,
    stripped_keywords: EXPECTED_STRIPPED.filter((kw) => probeRawKw.has(kw) && !probeOutKw.has(kw)),
    preserved_keywords: EXPECTED_PRESERVED.filter((kw) => submittedKeywords.has(kw)),
  };

  if (failures.length) {
    console.error("FAIL: hosted structured-output constraint guard");
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error("\nObserved asymmetry:");
    console.error(JSON.stringify(asymmetry, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log("PASS: hosted structured-output constraint guard");
  console.log("The compat layer strips cardinality/format constraints and keeps enum:");
  console.log(JSON.stringify(asymmetry, null, 2));
  console.log(
    "\nConsequence: span IDs resolve (enum kept) but the local 3-span cap is not",
  );
  console.log(
    "enforced at submission time (maxItems stripped). Experiment 1 tests whether",
  );
  console.log("retaining maxItems end-to-end is honored by each provider.");
}

run();
