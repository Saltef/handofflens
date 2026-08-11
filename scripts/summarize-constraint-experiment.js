"use strict";

// Analyze results from probe-structured-output-constraints.js.
// Computes per-provider arm summaries and the paired prompt_cap-vs-control
// contrast (the causal endpoint), and writes a markdown report.
//
// Usage: node scripts/summarize-constraint-experiment.js INPUT.json [OUTPUT.md]

const fs = require("node:fs");
const { rateSummary, mean, round } = require("./experiment-metrics");

function sd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

function normalCI(values) {
  if (!values.length) return [null, null];
  const m = mean(values);
  const half = 1.96 * (sd(values) / Math.sqrt(values.length));
  return [round(m - half, 3), round(m + half, 3)];
}

function pairedContrast(records, provider, baseArm, testArm) {
  const rows = records.filter((r) => r.provider === provider);
  const key = (r) => `${r.case_id}::${r.repeat}`;
  const base = new Map(rows.filter((r) => r.arm === baseArm && r.accepted).map((r) => [key(r), r]));
  const test = new Map(rows.filter((r) => r.arm === testArm && r.accepted).map((r) => [key(r), r]));
  const pairs = [];
  for (const [k, b] of base) {
    if (test.has(k)) pairs.push({ base: b, test: test.get(k) });
  }
  const violRateBase = pairs.map((p) => (p.base.item_count ? p.base.violation_count / p.base.item_count : 0));
  const violRateTest = pairs.map((p) => (p.test.item_count ? p.test.violation_count / p.test.item_count : 0));
  const dViol = pairs.map((_, i) => violRateTest[i] - violRateBase[i]);
  const dItems = pairs.map((p) => p.test.item_count - p.base.item_count);
  const dSupported = pairs.map((p) => (p.test.supported_count || 0) - (p.base.supported_count || 0));
  const dUnsupported = pairs.map(
    (p) => (p.test.item_count - (p.test.supported_count || 0)) - (p.base.item_count - (p.base.supported_count || 0)),
  );
  return {
    pairs: pairs.length,
    mean_violation_rate_base: pairs.length ? round(mean(violRateBase), 4) : null,
    mean_violation_rate_test: pairs.length ? round(mean(violRateTest), 4) : null,
    mean_paired_delta_violation_rate: pairs.length ? round(mean(dViol), 4) : null,
    delta_violation_rate_ci95: normalCI(dViol),
    mean_paired_delta_item_count: pairs.length ? round(mean(dItems), 3) : null,
    delta_item_count_ci95: normalCI(dItems),
    mean_paired_delta_supported_items: pairs.length ? round(mean(dSupported), 3) : null,
    delta_supported_items_ci95: normalCI(dSupported),
    mean_paired_delta_unsupported_items: pairs.length ? round(mean(dUnsupported), 3) : null,
    delta_unsupported_items_ci95: normalCI(dUnsupported),
  };
}

function armTable(summary) {
  const lines = [
    "| Arm | Accepted | Items | Supported items | Too-many-span rate [95%] | Mean spans/item | Span dist 0/1/2/3/4+ |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [arm, s] of Object.entries(summary)) {
    const acc = `${s.acceptance.numerator}/${s.acceptance.denominator}`;
    const viol = s.too_many_span_rate.rate == null
      ? "n/a"
      : `${s.too_many_span_rate.numerator}/${s.too_many_span_rate.denominator}, ${round(s.too_many_span_rate.rate * 100, 1)}% [${round(s.too_many_span_rate.wilson_95[0] * 100, 1)}, ${round(s.too_many_span_rate.wilson_95[1] * 100, 1)}]`;
    const sup = s.supported_item_rate && s.supported_item_rate.rate != null
      ? `${s.supported_item_count}, ${round(s.supported_item_rate.rate * 100, 1)}%`
      : (s.supported_item_count ?? "n/a");
    const d = s.span_count_distribution || {};
    const dist = `${d["0"] || 0}/${d["1"] || 0}/${d["2"] || 0}/${d["3"] || 0}/${d["4+"] || 0}`;
    lines.push(`| ${arm} | ${acc} | ${s.item_count} | ${sup} | ${viol} | ${s.mean_evidence_span_ids ?? "n/a"} | ${dist} |`);
  }
  return lines.join("\n");
}

function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3] || inPath.replace(/\.json$/i, "-report.md");
  if (!inPath) throw new Error("Usage: node scripts/summarize-constraint-experiment.js INPUT.json [OUTPUT.md]");
  const report = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const providers = Object.keys(report.summary);

  // Auto-detect base/test arm names (works for control/prompt_cap and
  // array_control/slots), or take them from --base/--test.
  const flags = {};
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === "--base") flags.base = process.argv[i + 1];
    if (process.argv[i] === "--test") flags.test = process.argv[i + 1];
  }
  const arms = [...new Set(report.records.map((r) => r.arm))];
  const baseArm = flags.base || arms.find((a) => /control/.test(a)) || arms[0];
  const testArm = flags.test || arms.find((a) => a !== baseArm && a !== "treatment") || arms[1];

  const out = [];
  out.push(`# Constraint Experiment Results -- ${report.experiment_id}`);
  out.push("");
  out.push(`Generated: ${report.generated_at}`);
  out.push(`Cases: ${report.cases_used} (from \`${report.cases_path}\`), repeats: ${report.repeats}, models: ${report.models.join(", ")}`);
  out.push("");
  out.push(`Claim boundary: ${report.claim_boundary}`);
  out.push("");

  for (const provider of providers) {
    out.push(`## ${provider}`);
    out.push("");
    out.push(armTable(report.summary[provider]));
    out.push("");
    const contrast = pairedContrast(report.records, provider, baseArm, testArm);
    out.push(`Paired ${testArm} vs ${baseArm} (per case/repeat, both accepted):`);
    out.push("");
    out.push(`- Pairs: ${contrast.pairs}`);
    out.push(`- Violation rate: control ${contrast.mean_violation_rate_base}, prompt_cap ${contrast.mean_violation_rate_test}`);
    out.push(`- Mean paired Delta violation rate: ${contrast.mean_paired_delta_violation_rate} [${contrast.delta_violation_rate_ci95.join(", ")}]`);
    out.push(`- Mean paired Delta item count: ${contrast.mean_paired_delta_item_count} [${contrast.delta_item_count_ci95.join(", ")}]`);
    out.push(`- Mean paired Delta SUPPORTED items: ${contrast.mean_paired_delta_supported_items} [${contrast.delta_supported_items_ci95.join(", ")}]  (recall proxy: negative = supported items lost)`);
    out.push(`- Mean paired Delta UNSUPPORTED items: ${contrast.mean_paired_delta_unsupported_items} [${contrast.delta_unsupported_items_ci95.join(", ")}]  (benign if the drop is concentrated here)`);
    out.push("");
  }

  const md = out.join("\n");
  fs.writeFileSync(outPath, `${md}\n`);
  console.log(md);
  console.log(`\nWrote ${outPath}`);
}

main();
