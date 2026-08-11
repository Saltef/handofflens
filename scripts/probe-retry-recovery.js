"use strict";

// Experiment `span-id-retry-recovery-v1`.
// See docs/preregistration-retry-experiment.md.
//
// Two-turn within-case test. First call = control span_id_v5 (array, can
// over-emit). If a case has items with more than 3 evidence_span_ids, send a
// corrective retry (the model's own output fed back plus a fix instruction) and
// re-score. The only manipulated variable is the retry turn.
//
// Usage:
//   node scripts/probe-retry-recovery.js --cases PATH [--limit N] [--repeats 1]
//     [--models ...] [--out results/retry-recovery.json]

const fs = require("node:fs");
const path = require("node:path");
const {
  buildAblationJob,
  callProvider,
  providerForModel,
} = require("./evaluate-span-id-v5-ablation");
const { rateSummary, mean, round } = require("./experiment-metrics");

const RETRY_INSTRUCTION =
  "Some items used more than 3 evidence_span_ids. Return the full JSON again with at most 3 evidence_span_ids per item, keeping only the most decisive spans. Do not add, drop, or otherwise change items.";

function parseArgs(argv) {
  const args = { repeats: 1, models: "cohere-aplus:command-a-plus-05-2026,anthropic/claude-haiku-4.5" };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    args[t.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function loadCases(casesPath) {
  const raw = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.cases)) return raw.cases;
  throw new Error(`No cases array in ${casesPath}`);
}

function spanIdsOf(item) {
  return Array.isArray(item.evidence_span_ids) ? item.evidence_span_ids : [];
}

function scoreItems(extraction, spanIdSet) {
  const items = Array.isArray(extraction && extraction.items) ? extraction.items : [];
  const detail = items.map((item) => {
    const ids = spanIdsOf(item);
    const resolves = ids.length > 0 && ids.every((id) => spanIdSet.has(id));
    const status = String(item.support_status || "");
    return { spans: ids.length, supported: status === "supported" && resolves && ids.length >= 1 };
  });
  return {
    item_count: items.length,
    violation_count: detail.filter((d) => d.spans > 3).length,
    supported_count: detail.filter((d) => d.supported).length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cases) throw new Error("Provide --cases PATH");
  const cases = loadCases(args.cases);
  const limited = args.limit ? cases.slice(0, Number(args.limit)) : cases;
  const models = args.models.split(",").map((m) => m.trim()).filter(Boolean);
  const repeats = Number(args.repeats) || 1;
  const outPath = args.out || path.join("results", "retry-recovery.json");

  const records = [];
  for (const model of models) {
    for (const testCase of limited) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const job = buildAblationJob(testCase, "span_id_v5", model, repeat);
        const spanIdSet = new Set(job.spanIndex.spans.map((s) => s.id));
        const provider = providerForModel(model);
        const rec = { model, provider, case_id: testCase.case_id, repeat };
        try {
          const first = await callProvider({ model, request: job.request });
          const before = scoreItems(first.extraction, spanIdSet);
          rec.before = before;
          if (before.violation_count === 0) {
            rec.status = "no_retry_needed";
            rec.after = before;
          } else {
            const retryRequest = structuredClone(job.request);
            retryRequest.messages.push({ role: "assistant", content: JSON.stringify(first.extraction) });
            retryRequest.messages.push({ role: "user", content: RETRY_INSTRUCTION });
            const second = await callProvider({ model, request: retryRequest });
            rec.after = scoreItems(second.extraction, spanIdSet);
            rec.status = "retried";
          }
        } catch (error) {
          rec.status = "error";
          rec.error = String(error && error.message ? error.message : error).slice(0, 300);
        }
        records.push(rec);
        const a = rec.after || {};
        const b = rec.before || {};
        console.log(`${provider} ${testCase.case_id} r${repeat} ${rec.status}: viol ${b.violation_count ?? "?"}->${a.violation_count ?? "?"}, sup ${b.supported_count ?? "?"}->${a.supported_count ?? "?"}, items ${b.item_count ?? "?"}->${a.item_count ?? "?"}`);
      }
    }
  }

  const byProvider = {};
  for (const provider of [...new Set(records.map((r) => r.provider))]) {
    const rows = records.filter((r) => r.provider === provider && r.before && r.after);
    const retried = rows.filter((r) => r.status === "retried");
    const dViol = retried.map((r) => r.after.violation_count - r.before.violation_count);
    const dSup = retried.map((r) => r.after.supported_count - r.before.supported_count);
    const dItems = retried.map((r) => r.after.item_count - r.before.item_count);
    const violBefore = retried.reduce((a, r) => a + r.before.violation_count, 0);
    const violAfter = retried.reduce((a, r) => a + r.after.violation_count, 0);
    byProvider[provider] = {
      cases: rows.length,
      cases_with_violations: retried.length,
      no_retry_needed: rows.filter((r) => r.status === "no_retry_needed").length,
      violating_items_before: violBefore,
      violating_items_after: violAfter,
      violating_item_recovery_rate: rateSummary(violBefore - violAfter, violBefore),
      mean_delta_violations_per_case: retried.length ? round(mean(dViol), 3) : null,
      mean_delta_supported_per_case: retried.length ? round(mean(dSup), 3) : null,
      mean_delta_items_per_case: retried.length ? round(mean(dItems), 3) : null,
    };
  }

  const report = {
    experiment_id: "span-id-retry-recovery-v1",
    generated_at: new Date().toISOString(),
    cases_path: args.cases,
    cases_used: limited.length,
    repeats,
    models,
    claim_boundary:
      "Contract-following recovery on a hard slice. Whether a corrective retry restores the <=3 span contract while preserving supported items. Not semantic entailment, clinical correctness, target recall, or model superiority.",
    summary: byProvider,
    records,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(byProvider, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
