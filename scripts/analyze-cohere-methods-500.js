#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const root = args.root || "results/cohere-methods-500-v3";
const outPath = args.out || path.join(root, "analysis.json");
const mdPath = args.mdout || path.join(root, "analysis.md");
const cellIds = ["json_schema_thinking_128", "json_schema_thinking_512", "strict_tool_thinking_512"];
const reports = Object.fromEntries(cellIds.map((cell) => [cell, read(path.join(root, `${cell}.json`))]));
const caseIds = reports[cellIds[0]].cases;
const byCell = Object.fromEntries(cellIds.map((cell) => [cell, Object.fromEntries(reports[cell].results.map((item) => [item.case_id, item]))]));

const technical = Object.fromEntries(cellIds.map((cell) => [cell, technicalSummary(caseIds.map((id) => byCell[cell][id]))]));
const comparisons = [];
for (let i = 0; i < cellIds.length; i += 1) for (let j = i + 1; j < cellIds.length; j += 1) comparisons.push(compareCells(cellIds[i], cellIds[j]));
holmAdjust(comparisons, "mcnemar_p");

const judgePath = path.join(root, "comparative-judge.json");
const judge = fs.existsSync(judgePath) ? analyzeJudge(read(judgePath)) : { status: "not_run" };
const analysis = {
  generated_at: new Date().toISOString(), experiment_id: read(path.join(root, "manifest.json")).experiment_id,
  primary_endpoint: "first-pass locally valid structured-output rate", case_count: caseIds.length,
  technical, paired_comparisons: comparisons, judge,
  interpretation_boundary: "LLM-judge findings are development proxies. No clinical safety, appropriateness, external-validity, or human-equivalence claim is supported."
};
fs.writeFileSync(outPath, `${JSON.stringify(analysis, null, 2)}\n`);
fs.writeFileSync(mdPath, renderMarkdown(analysis));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdPath}`);

function technicalSummary(items) {
  const n = items.length;
  const success = items.filter((item) => item && !item.error && item.extraction).length;
  const rawValid = items.filter((item) => item?.raw_schema_valid === true).length;
  const latencies = items.filter((item) => item && !item.error).map((item) => item.latency_ms).sort((a, b) => a - b);
  const input = items.map((item) => item?.telemetry?.usage?.billed_input_tokens).filter(Number.isFinite);
  const output = items.map((item) => item?.telemetry?.usage?.billed_output_tokens).filter(Number.isFinite);
  return { attempted: n, completed: success, completion_rate: success / n, completion_ci95: wilson(success, n), raw_schema_valid: rawValid, raw_schema_valid_rate: rawValid / n, raw_schema_valid_ci95: wilson(rawValid, n), latency_ms_median: quantile(latencies, 0.5), latency_ms_p95: quantile(latencies, 0.95), billed_input_tokens_total: sum(input), billed_output_tokens_total: sum(output) };
}

function compareCells(a, b) {
  const av = caseIds.map((id) => Number(Boolean(byCell[a][id]?.extraction && !byCell[a][id]?.error && byCell[a][id]?.raw_schema_valid === true)));
  const bv = caseIds.map((id) => Number(Boolean(byCell[b][id]?.extraction && !byCell[b][id]?.error && byCell[b][id]?.raw_schema_valid === true)));
  let aOnly = 0, bOnly = 0;
  for (let i = 0; i < av.length; i += 1) { if (av[i] && !bv[i]) aOnly += 1; if (!av[i] && bv[i]) bOnly += 1; }
  const diffs = av.map((value, i) => value - bv[i]);
  return { cell_a: a, cell_b: b, estimand: "paired risk difference in first-pass locally valid output (A minus B)", risk_difference: mean(diffs), bootstrap_ci95: bootstrapMeanCi(diffs, 10000, 20260621), discordant_a_only: aOnly, discordant_b_only: bOnly, mcnemar_p: exactMcNemar(aOnly, bOnly), holm_adjusted_p: null };
}

function analyzeJudge(report) {
  const primary = report.judgments.filter((item) => !item.repeat && item.judgment);
  const repeats = report.judgments.filter((item) => item.repeat && item.judgment);
  const rates = {};
  for (const cell of cellIds) {
    const labels = primary.map((record) => auditForCell(record, cell)).filter(Boolean);
    rates[cell] = { judged: labels.length, any_semantic_error: labels.filter((item) => item.any_semantic_error).length, any_semantic_error_rate: labels.length ? labels.filter((item) => item.any_semantic_error).length / labels.length : null, ci95: wilson(labels.filter((item) => item.any_semantic_error).length, labels.length) };
  }
  const repeatByCase = Object.fromEntries(repeats.map((item) => [item.case_id, item]));
  const consistency = {};
  for (const cell of cellIds) {
    const pairs = primary.map((item) => [auditForCell(item, cell), auditForCell(repeatByCase[item.case_id], cell)]).filter(([a, b]) => a && b);
    const agree = pairs.filter(([a, b]) => a.any_semantic_error === b.any_semantic_error).length;
    consistency[cell] = { repeated_cases: pairs.length, binary_agreement: pairs.length ? agree / pairs.length : null, cohen_kappa: kappa(pairs.map(([a]) => a.any_semantic_error), pairs.map(([, b]) => b.any_semantic_error)) };
  }
  return { status: "complete", model: report.judge_model, primary_cases: primary.length, rates, reversed_order_consistency: consistency };
}

function auditForCell(record, cell) { if (!record?.judgment) return null; const label = Object.entries(record.blind_map || {}).find(([, value]) => value === cell)?.[0]; return record.judgment.audits?.find((item) => item.output_label === label) || null; }
function exactMcNemar(aOnly, bOnly) { const n = aOnly + bOnly; if (!n) return 1; let tail = 0; const k = Math.min(aOnly, bOnly); for (let i = 0; i <= k; i += 1) tail += combination(n, i) * 0.5 ** n; return Math.min(1, 2 * tail); }
function combination(n, k) { k = Math.min(k, n - k); let value = 1; for (let i = 1; i <= k; i += 1) value = value * (n - k + i) / i; return value; }
function holmAdjust(items, field) { const ordered = items.map((item, index) => ({ item, index })).sort((a, b) => a.item[field] - b.item[field]); let prior = 0; ordered.forEach(({ item }, rank) => { prior = Math.max(prior, Math.min(1, item[field] * (ordered.length - rank))); item.holm_adjusted_p = prior; }); }
function bootstrapMeanCi(values, iterations, seed) { let state = seed >>> 0; const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32); const means = []; for (let b = 0; b < iterations; b += 1) { let total = 0; for (let i = 0; i < values.length; i += 1) total += values[Math.floor(random() * values.length)]; means.push(total / values.length); } means.sort((a, b) => a - b); return [quantile(means, 0.025), quantile(means, 0.975)]; }
function wilson(x, n) { if (!n) return null; const z = 1.959963984540054, p = x / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }
function kappa(a, b) { if (!a.length) return null; const po = a.filter((v, i) => v === b[i]).length / a.length, pa = a.filter(Boolean).length / a.length, pb = b.filter(Boolean).length / b.length, pe = pa * pb + (1 - pa) * (1 - pb); return pe === 1 ? (po === 1 ? 1 : null) : (po - pe) / (1 - pe); }
function quantile(values, q) { if (!values.length) return null; const index = (values.length - 1) * q, lo = Math.floor(index), hi = Math.ceil(index); return values[lo] + (values[hi] - values[lo]) * (index - lo); }
function mean(values) { return values.length ? sum(values) / values.length : null; }
function sum(values) { return values.reduce((a, b) => a + b, 0); }
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function renderMarkdown(a) { const lines = [`# Cohere Methods 500: Prespecified Analysis`, "", `Cases: ${a.case_count}`, "", "## Technical endpoints", "", "| Cell | Valid output | Rate | Median latency |", "|---|---:|---:|---:|", ...cellIds.map((cell) => { const x = a.technical[cell]; return `| ${cell} | ${x.raw_schema_valid}/${x.attempted} | ${(100 * x.raw_schema_valid_rate).toFixed(1)}% | ${x.latency_ms_median === null ? "NA" : (x.latency_ms_median / 1000).toFixed(2) + " s"} |`; }), "", "## Paired comparisons", "", "| A minus B | Risk difference | 95% bootstrap CI | Holm p |", "|---|---:|---:|---:|", ...a.paired_comparisons.map((x) => `| ${x.cell_a} − ${x.cell_b} | ${(100 * x.risk_difference).toFixed(1)} pp | ${x.bootstrap_ci95.map((v) => (100 * v).toFixed(1)).join(" to ")} pp | ${x.holm_adjusted_p.toPrecision(3)} |`), "", `> ${a.interpretation_boundary}`, ""]; return `${lines.join("\n")}\n`; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
