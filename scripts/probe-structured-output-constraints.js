"use strict";

// Experiment `structured-output-maxitems-causal-v1`.
// See docs/preregistration-constraint-experiment.md.
//
// Paired within-case A/B on the span_id_v5 arm. The ONLY difference between arms
// is whether `maxItems` survives into the submitted schema:
//   control   = current compat layer (all 8 cardinality/format keywords stripped)
//   treatment = strip the other 7, retain maxItems
// Everything else (cases, prompt, temperature, span index, enum) is held fixed.
//
// Usage:
//   node scripts/probe-structured-output-constraints.js --dry [--cases PATH]
//   node scripts/probe-structured-output-constraints.js --cases PATH \
//     [--models cohere-aplus:command-a-plus-05-2026,anthropic/claude-haiku-4.5] \
//     [--repeats 1] [--limit N] [--out results/constraint-experiment.json]

const fs = require("node:fs");
const path = require("node:path");
const {
  buildAblationJob,
  callProvider,
  providerForModel,
  toProviderCompatibleSchema,
} = require("./evaluate-span-id-v5-ablation");
const { rateSummary, mean, round } = require("./experiment-metrics");

const STRIP_EXCEPT_MAXITEMS = new Set([
  "minItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "uniqueItems",
]);

function parseArgs(argv) {
  const args = { repeats: 1, models: "cohere-aplus:command-a-plus-05-2026,anthropic/claude-haiku-4.5" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "dry") {
      args.dry = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

// Treatment schema: strip the 7 unsupported keywords, keep maxItems.
function retainMaxItemsSchema(rawSchema) {
  const base = toProviderCompatibleSchema(rawSchema);
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !STRIP_EXCEPT_MAXITEMS.has(key))
        .map(([key, value]) => [key, visit(value)]),
    );
  };
  return visit(base);
}

const PROMPT_CAP_INSTRUCTION =
  " Hard limit: emit at most 3 evidence_span_ids per item. If more than 3 spans seem relevant, select only the 3 most decisive and drop the rest.";

// prompt_cap arm: control schema (maxItems stripped) plus one appended system
// instruction. The instruction is the only manipulated variable vs control.
function withSystemAppend(request, text) {
  const cloned = structuredClone(request);
  const sys = cloned.messages.find((m) => m.role === "system");
  if (!sys) throw new Error("No system message to append to");
  sys.content = `${sys.content}${text}`;
  return cloned;
}

// Swap the JSON schema inside a provider request, matching the provider's shape.
function withSchema(request, schema) {
  const cloned = structuredClone(request);
  if (cloned.response_format && cloned.response_format.type === "json_schema") {
    cloned.response_format.json_schema.schema = schema;
  } else if (cloned.response_format && "schema" in cloned.response_format) {
    cloned.response_format.schema = schema;
  } else {
    throw new Error("Unrecognized response_format shape; cannot swap schema");
  }
  return cloned;
}

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

function loadCases(casesPath) {
  const raw = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.cases)) return raw.cases;
  throw new Error(`No cases array found in ${casesPath}`);
}

function spanIdsOf(item) {
  const ids = item && item.evidence_span_ids;
  return Array.isArray(ids) ? ids : [];
}

function dryRun(args) {
  const casesPath = args.cases || path.join("eval", "pilot_reference_cases.json");
  const cases = loadCases(casesPath);
  const testCase = cases[0];
  const model = "cohere-aplus:command-a-plus-05-2026";
  const job = buildAblationJob(testCase, "span_id_v5", model, 1);

  const controlSchema = job.request.response_format.schema; // already stripped
  const treatmentSchema = retainMaxItemsSchema(job.outputSchema);

  const controlKw = collectKeywords(controlSchema);
  const treatmentKw = collectKeywords(treatmentSchema);
  const onlyInTreatment = [...treatmentKw].filter((k) => !controlKw.has(k));
  const onlyInControl = [...controlKw].filter((k) => !treatmentKw.has(k));

  console.log(`DRY RUN — case ${testCase.case_id}, model ${model}`);
  console.log(`cases: ${casesPath} (${cases.length} loaded)`);
  console.log(`control keywords:   ${[...controlKw].sort().join(", ")}`);
  console.log(`treatment keywords: ${[...treatmentKw].sort().join(", ")}`);
  console.log(`only in treatment:  ${JSON.stringify(onlyInTreatment)}`);
  console.log(`only in control:    ${JSON.stringify(onlyInControl)}`);

  const singleVariable = onlyInTreatment.length === 1 && onlyInTreatment[0] === "maxItems" && onlyInControl.length === 0;
  console.log(
    singleVariable
      ? "OK: the two arms differ by exactly one keyword (maxItems)."
      : "PROBLEM: arms differ by more than maxItems — fix before spending.",
  );
  process.exitCode = singleVariable ? 0 : 1;
}

async function callArm({ model, request }, spanIdSet) {
  const started = Date.now();
  try {
    const { extraction } = await callProvider({ model, request });
    const items = Array.isArray(extraction && extraction.items) ? extraction.items : [];
    const spanCounts = items.map((item) => spanIdsOf(item).length);
    const violations = spanCounts.filter((n) => n > 3).length;
    // Provenance-support proxy (not gold recall): the item claims support, its
    // span IDs resolve in the frozen span index, and it has at least one span.
    const detail = items.map((item) => {
      const ids = spanIdsOf(item);
      const resolves = ids.length > 0 && (spanIdSet ? ids.every((id) => spanIdSet.has(id)) : true);
      const status = String(item.support_status || "");
      return { spans: ids.length, status, supported: status === "supported" && resolves && ids.length >= 1 };
    });
    return {
      accepted: true,
      error: null,
      item_count: items.length,
      violation_count: violations,
      span_counts: spanCounts,
      supported_count: detail.filter((d) => d.supported).length,
      item_detail: detail,
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      accepted: false,
      error: String(error && error.message ? error.message : error).slice(0, 400),
      item_count: 0,
      violation_count: 0,
      span_counts: [],
      supported_count: 0,
      item_detail: [],
      latency_ms: Date.now() - started,
    };
  }
}

function summarizeProvider(records) {
  const perArm = {};
  for (const arm of [...new Set(records.map((r) => r.arm))]) {
    const rows = records.filter((r) => r.arm === arm);
    const accepted = rows.filter((r) => r.accepted);
    const totalItems = accepted.reduce((acc, r) => acc + r.item_count, 0);
    const totalViolations = accepted.reduce((acc, r) => acc + r.violation_count, 0);
    const totalSupported = accepted.reduce((acc, r) => acc + (r.supported_count || 0), 0);
    const allSpanCounts = accepted.flatMap((r) => r.span_counts);
    const dist = { "0": 0, "1": 0, "2": 0, "3": 0, "4+": 0 };
    for (const n of allSpanCounts) dist[n >= 4 ? "4+" : String(n)] += 1;
    perArm[arm] = {
      runs: rows.length,
      acceptance: rateSummary(accepted.length, rows.length),
      item_count: totalItems,
      supported_item_count: totalSupported,
      supported_item_rate: rateSummary(totalSupported, totalItems),
      too_many_span_rate: rateSummary(totalViolations, totalItems),
      mean_evidence_span_ids: allSpanCounts.length ? round(mean(allSpanCounts), 3) : null,
      span_count_distribution: dist,
      errors: rows.filter((r) => !r.accepted).map((r) => r.error).slice(0, 5),
    };
  }
  return perArm;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dry) {
    dryRun(args);
    return;
  }
  if (!args.cases) throw new Error("Provide --cases PATH (use --dry for an offline check)");

  const cases = loadCases(args.cases);
  const limited = args.limit ? cases.slice(0, Number(args.limit)) : cases;
  const models = args.models.split(",").map((m) => m.trim()).filter(Boolean);
  const repeats = Number(args.repeats) || 1;
  const selectedArms = args.arms ? args.arms.split(",").map((a) => a.trim()).filter(Boolean) : null;
  const outPath = args.out || path.join("results", "constraint-experiment.json");

  const records = [];
  for (const model of models) {
    for (const testCase of limited) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const job = buildAblationJob(testCase, "span_id_v5", model, repeat);
        const allArms = [
          { arm: "control", request: job.request },
          { arm: "treatment", request: withSchema(job.request, retainMaxItemsSchema(job.outputSchema)) },
          { arm: "prompt_cap", request: withSystemAppend(job.request, PROMPT_CAP_INSTRUCTION) },
        ];
        const arms = selectedArms ? allArms.filter((a) => selectedArms.includes(a.arm)) : allArms;
        const spanIdSet = new Set((job.spanIndex.spans || []).map((s) => s.id));
        for (const { arm, request } of arms) {
          const result = await callArm({ model, request }, spanIdSet);
          records.push({ model, provider: providerForModel(model), case_id: testCase.case_id, repeat, arm, ...result });
          const flag = result.accepted ? `${result.violation_count}/${result.item_count} viol` : `ERR ${result.error}`;
          console.log(`${providerForModel(model)} ${testCase.case_id} r${repeat} ${arm}: ${flag}`);
        }
      }
    }
  }

  const byProvider = {};
  for (const provider of [...new Set(records.map((r) => r.provider))]) {
    byProvider[provider] = summarizeProvider(records.filter((r) => r.provider === provider));
  }

  const report = {
    experiment_id: "structured-output-maxitems-causal-v1",
    generated_at: new Date().toISOString(),
    cases_path: args.cases,
    cases_used: limited.length,
    repeats,
    models,
    claim_boundary:
      "Submission-contract manipulation only. Tests whether a provider honors maxItems end to end. Not semantic entailment, clinical correctness, or model superiority.",
    summary: byProvider,
    records,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(byProvider, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
