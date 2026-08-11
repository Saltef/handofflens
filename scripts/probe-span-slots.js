"use strict";

// Design-around test for the span-cap problem.
// See docs/preregistration-span-slots-experiment.md.
//
// The array constraint `evidence_span_ids: {maxItems: 3}` is stripped by the
// hosted compat layer and rejected by both providers. This arm replaces the
// array with THREE optional named enum fields (evidence_span_1/2/3). "At most 3"
// then holds by construction, only `enum` is used (which survives the compat
// layer), and the model still extracts every item (no recall cap).
//
//   array_control : standard span_id_v5 (array, stripped)  -> can over-emit
//   slots         : three named enum span fields           -> <=3 by construction
//
// Usage:
//   node scripts/probe-span-slots.js --dry [--cases PATH]
//   node scripts/probe-span-slots.js --cases PATH [--limit N] [--repeats 1] \
//     [--models ...] [--arms array_control,slots] [--out results/span-slots.json]

const fs = require("node:fs");
const path = require("node:path");
const {
  buildAblationJob,
  buildOutputSchema,
  callProvider,
  providerForModel,
  toCohereCompatibleSchema,
} = require("./evaluate-span-id-v5-ablation");
const { rateSummary, mean, round } = require("./experiment-metrics");

const SLOTS_INSTRUCTION =
  " IMPORTANT output-format change: there is no evidence_span_ids array. Put up to three supporting span IDs in the separate fields evidence_span_1, evidence_span_2, evidence_span_3, most decisive first. Omit the unused fields. Never use more than these three.";

function parseArgs(argv) {
  const args = { repeats: 1, models: "cohere-aplus:command-a-plus-05-2026,anthropic/claude-haiku-4.5" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "dry") { args.dry = true; continue; }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

// Transform the span_id_v5 schema: drop the evidence_span_ids array, add three
// optional named enum span fields.
function toSlotsSchema(spanIds) {
  const schema = buildOutputSchema({ arm: "span_id_v5", spanIds });
  const item = schema.properties.items.items;
  delete item.properties.evidence_span_ids;
  item.required = item.required.filter((r) => r !== "evidence_span_ids");
  const spanField = spanIds.length
    ? { type: "string", enum: spanIds }
    : { type: "string", pattern: "^S[1-9][0-9]*$" };
  item.properties.evidence_span_1 = spanField;
  item.properties.evidence_span_2 = spanField;
  item.properties.evidence_span_3 = spanField;
  return schema;
}

function withSchema(request, schema) {
  const cloned = structuredClone(request);
  if (cloned.response_format && cloned.response_format.type === "json_schema") {
    cloned.response_format.json_schema.schema = schema;
  } else if (cloned.response_format && "schema" in cloned.response_format) {
    cloned.response_format.schema = schema;
  } else {
    throw new Error("Unrecognized response_format shape");
  }
  return cloned;
}

function withSystemAppend(request, text) {
  const cloned = structuredClone(request);
  const sys = cloned.messages.find((m) => m.role === "system");
  if (!sys) throw new Error("No system message");
  sys.content = `${sys.content}${text}`;
  return cloned;
}

// Read span IDs from either the array form or the named-slot form.
function spanIdsOf(item, arm) {
  if (arm === "slots") {
    return [item.evidence_span_1, item.evidence_span_2, item.evidence_span_3].filter(
      (v) => typeof v === "string" && v.length,
    );
  }
  return Array.isArray(item.evidence_span_ids) ? item.evidence_span_ids : [];
}

function loadCases(casesPath) {
  const raw = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.cases)) return raw.cases;
  throw new Error(`No cases array in ${casesPath}`);
}

function collectKeywords(node, found = new Set()) {
  if (Array.isArray(node)) { node.forEach((c) => collectKeywords(c, found)); return found; }
  if (!node || typeof node !== "object") return found;
  for (const [k, v] of Object.entries(node)) { found.add(k); collectKeywords(v, found); }
  return found;
}

function buildArms(job, spanIds) {
  const slotsSchemaSubmitted = toCohereCompatibleSchema(toSlotsSchema(spanIds));
  return [
    { arm: "array_control", request: job.request },
    { arm: "slots", request: withSystemAppend(withSchema(job.request, slotsSchemaSubmitted), SLOTS_INSTRUCTION) },
  ];
}

function dryRun(args) {
  const casesPath = args.cases || path.join("eval", "pilot_reference_cases.json");
  const cases = loadCases(casesPath);
  const job = buildAblationJob(cases[0], "span_id_v5", "cohere-aplus:command-a-plus-05-2026", 1);
  const spanIds = job.spanIndex.spans.map((s) => s.id);
  const slotsSubmitted = toCohereCompatibleSchema(toSlotsSchema(spanIds));
  const kw = collectKeywords(slotsSubmitted);
  const item = slotsSubmitted.properties.items.items;
  console.log(`DRY RUN -- case ${cases[0].case_id}`);
  console.log(`slots item fields: ${Object.keys(item.properties).join(", ")}`);
  console.log(`has evidence_span_ids: ${"evidence_span_ids" in item.properties}`);
  console.log(`has evidence_span_1/2/3: ${["evidence_span_1", "evidence_span_2", "evidence_span_3"].every((f) => f in item.properties)}`);
  console.log(`maxItems present anywhere: ${kw.has("maxItems")}`);
  console.log(`enum present: ${kw.has("enum")}`);
  const ok = !("evidence_span_ids" in item.properties)
    && ["evidence_span_1", "evidence_span_2", "evidence_span_3"].every((f) => f in item.properties)
    && !kw.has("maxItems") && kw.has("enum");
  console.log(ok ? "OK: <=3 by construction, no maxItems, enum kept." : "PROBLEM: slots schema malformed.");
  process.exitCode = ok ? 0 : 1;
}

async function callArm({ model, request }, arm, spanIdSet) {
  const started = Date.now();
  try {
    const { extraction } = await callProvider({ model, request });
    const items = Array.isArray(extraction && extraction.items) ? extraction.items : [];
    const detail = items.map((item) => {
      const ids = spanIdsOf(item, arm);
      const resolves = ids.length > 0 && ids.every((id) => spanIdSet.has(id));
      const status = String(item.support_status || "");
      return { spans: ids.length, supported: status === "supported" && resolves && ids.length >= 1 };
    });
    return {
      accepted: true,
      error: null,
      item_count: items.length,
      violation_count: detail.filter((d) => d.spans > 3).length,
      supported_count: detail.filter((d) => d.supported).length,
      span_counts: detail.map((d) => d.spans),
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      accepted: false,
      error: String(error && error.message ? error.message : error).slice(0, 400),
      item_count: 0, violation_count: 0, supported_count: 0, span_counts: [], latency_ms: Date.now() - started,
    };
  }
}

function summarizeProvider(records) {
  const perArm = {};
  for (const arm of [...new Set(records.map((r) => r.arm))]) {
    const rows = records.filter((r) => r.arm === arm);
    const accepted = rows.filter((r) => r.accepted);
    const items = accepted.reduce((a, r) => a + r.item_count, 0);
    const viol = accepted.reduce((a, r) => a + r.violation_count, 0);
    const sup = accepted.reduce((a, r) => a + r.supported_count, 0);
    const spans = accepted.flatMap((r) => r.span_counts);
    perArm[arm] = {
      runs: rows.length,
      acceptance: rateSummary(accepted.length, rows.length),
      item_count: items,
      supported_item_count: sup,
      too_many_span_rate: rateSummary(viol, items),
      mean_evidence_spans: spans.length ? round(mean(spans), 3) : null,
      errors: rows.filter((r) => !r.accepted).map((r) => r.error).slice(0, 3),
    };
  }
  return perArm;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dry) { dryRun(args); return; }
  if (!args.cases) throw new Error("Provide --cases PATH (or --dry)");

  const cases = loadCases(args.cases);
  const limited = args.limit ? cases.slice(0, Number(args.limit)) : cases;
  const models = args.models.split(",").map((m) => m.trim()).filter(Boolean);
  const repeats = Number(args.repeats) || 1;
  const selectedArms = args.arms ? args.arms.split(",").map((a) => a.trim()) : null;
  const outPath = args.out || path.join("results", "span-slots.json");

  const records = [];
  for (const model of models) {
    for (const testCase of limited) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const job = buildAblationJob(testCase, "span_id_v5", model, repeat);
        const spanIds = job.spanIndex.spans.map((s) => s.id);
        const spanIdSet = new Set(spanIds);
        let arms = buildArms(job, spanIds);
        if (selectedArms) arms = arms.filter((a) => selectedArms.includes(a.arm));
        for (const { arm, request } of arms) {
          const result = await callArm({ model, request }, arm, spanIdSet);
          records.push({ model, provider: providerForModel(model), case_id: testCase.case_id, repeat, arm, ...result });
          const flag = result.accepted ? `${result.violation_count}/${result.item_count} viol, ${result.supported_count} sup` : `ERR ${result.error}`;
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
    experiment_id: "span-slots-design-around-v1",
    generated_at: new Date().toISOString(),
    cases_path: args.cases,
    cases_used: limited.length,
    repeats,
    models,
    claim_boundary:
      "Design-around test only. Whether named enum span slots survive the hosted path and bound span count by construction while preserving items/support. Not semantic entailment, clinical correctness, target recall, or model superiority.",
    summary: byProvider,
    records,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(byProvider, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
