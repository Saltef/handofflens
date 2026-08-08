#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const QUERY_METHOD = "query_aware_multispan";

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const stressPaths = parsePathList(required(args.stress, "--stress is required"));
  const coherencePaths = parsePathList(required(args.coherence, "--coherence is required"));
  const outPath = args.out || null;
  const summary = summarizeDecompositionReports({
    stressReports: stressPaths.map(readJson),
    coherenceReports: coherencePaths.map(readJson),
    labels: parsePathList(args.labels || ""),
  });
  const output = `${JSON.stringify(summary, null, 2)}\n`;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
    fs.writeFileSync(args.mdout || outPath.replace(/\.json$/i, ".md"), renderMarkdown(summary));
  }
  console.log(output.trim());
}

function summarizeDecompositionReports({ stressReports, coherenceReports, labels = [] }) {
  if (!stressReports.length) throw new Error("At least one stress report is required");
  if (stressReports.length !== coherenceReports.length) {
    throw new Error("Stress and coherence report counts must match");
  }

  const cells = stressReports.map((stress, index) => {
    const coherence = coherenceReports[index];
    const label = labels[index] || `cell_${index + 1}`;
    const exact = methodSummary(stress, "exact_full_note");
    const normalized = methodSummary(stress, "normalized_full_note");
    const lineSpan = methodSummary(stress, "line_span_id");
    const sectionFiltered = methodSummary(stress, "section_filtered_span");
    const query = methodSummary(stress, QUERY_METHOD);
    return {
      label,
      tasks: number(stress.summary?.tasks),
      source_records: number(stress.summary?.source_records),
      exact_supported_tasks: number(exact.supported_tasks),
      normalized_supported_tasks: number(normalized.supported_tasks),
      line_span_supported_tasks: number(lineSpan.supported_tasks),
      section_filtered_supported_tasks: number(sectionFiltered.supported_tasks),
      query_aware_supported_tasks: query.supported_tasks,
      query_aware_support_rate: query.support_rate,
      normalized_mean_context_words_supported: number(normalized.mean_selected_context_words_supported),
      line_span_mean_context_words_supported: number(lineSpan.mean_selected_context_words_supported),
      section_filtered_mean_context_words_supported: number(sectionFiltered.mean_selected_context_words_supported),
      query_aware_mean_context_words_supported: query.mean_selected_context_words_supported,
      query_aware_status_counts: query.status_counts || {},
      miss_category_counts: stress.summary?.dominant_task_miss_categories || {},
      auto_accepted_supported_tasks: number(coherence.summary?.auto_accepted_supported_tasks),
      review_required_supported_tasks: number(coherence.summary?.review_required_supported_tasks),
      blocked_supported_tasks: number(coherence.summary?.blocked_supported_tasks),
      unsupported_tasks: number(coherence.summary?.unsupported_tasks),
      high_risk_supported_tasks: number(coherence.summary?.high_risk_supported_tasks),
      medium_risk_supported_tasks: number(coherence.summary?.medium_risk_supported_tasks),
      low_risk_supported_tasks: number(coherence.summary?.low_risk_supported_tasks),
      low_overlap_review_rescue_supported_tasks: number(coherence.summary?.medium_risk_reasons?.low_overlap_review_rescue),
    };
  });

  const aggregate = {
    cells: cells.length,
    tasks: sum(cells.map((cell) => cell.tasks)),
    source_records_observed_within_cells: sum(cells.map((cell) => cell.source_records)),
    exact_supported_tasks: sum(cells.map((cell) => cell.exact_supported_tasks)),
    normalized_supported_tasks: sum(cells.map((cell) => cell.normalized_supported_tasks)),
    line_span_supported_tasks: sum(cells.map((cell) => cell.line_span_supported_tasks)),
    section_filtered_supported_tasks: sum(cells.map((cell) => cell.section_filtered_supported_tasks)),
    query_aware_supported_tasks: sum(cells.map((cell) => cell.query_aware_supported_tasks)),
    auto_accepted_supported_tasks: sum(cells.map((cell) => cell.auto_accepted_supported_tasks)),
    review_required_supported_tasks: sum(cells.map((cell) => cell.review_required_supported_tasks)),
    blocked_supported_tasks: sum(cells.map((cell) => cell.blocked_supported_tasks)),
    abstained_tasks: sum(cells.map((cell) => cell.unsupported_tasks)),
    high_risk_supported_tasks: sum(cells.map((cell) => cell.high_risk_supported_tasks)),
    medium_risk_supported_tasks: sum(cells.map((cell) => cell.medium_risk_supported_tasks)),
    low_risk_supported_tasks: sum(cells.map((cell) => cell.low_risk_supported_tasks)),
    low_overlap_review_rescue_supported_tasks: sum(cells.map((cell) => cell.low_overlap_review_rescue_supported_tasks)),
    query_aware_status_counts: mergeCounts(cells.map((cell) => cell.query_aware_status_counts)),
    miss_category_counts: mergeCounts(cells.map((cell) => cell.miss_category_counts)),
  };
  aggregate.query_aware_support_rate = ratio(aggregate.query_aware_supported_tasks, aggregate.tasks);
  aggregate.auto_accept_rate = ratio(aggregate.auto_accepted_supported_tasks, aggregate.tasks);
  aggregate.review_required_rate = ratio(aggregate.review_required_supported_tasks, aggregate.tasks);
  aggregate.abstention_rate = ratio(aggregate.abstained_tasks, aggregate.tasks);
  aggregate.normalized_support_rate = ratio(aggregate.normalized_supported_tasks, aggregate.tasks);
  aggregate.line_span_support_rate = ratio(aggregate.line_span_supported_tasks, aggregate.tasks);
  aggregate.section_filtered_support_rate = ratio(aggregate.section_filtered_supported_tasks, aggregate.tasks);
  aggregate.mean_context_words_on_supported_items = {
    normalized_full_note: weightedMean(cells.map((cell) => ({
      weight: cell.normalized_supported_tasks,
      value: cell.normalized_mean_context_words_supported,
    }))),
    line_span_id: weightedMean(cells.map((cell) => ({
      weight: cell.line_span_supported_tasks,
      value: cell.line_span_mean_context_words_supported,
    }))),
    section_filtered_span: weightedMean(cells.map((cell) => ({
      weight: cell.section_filtered_supported_tasks,
      value: cell.section_filtered_mean_context_words_supported,
    }))),
    query_aware_multispan: weightedMean(cells.map((cell) => ({
      weight: cell.query_aware_supported_tasks,
      value: cell.query_aware_mean_context_words_supported,
    }))),
  };
  aggregate.mean_query_context_words_supported = aggregate.mean_context_words_on_supported_items.query_aware_multispan;

  return {
    generated_at: new Date().toISOString(),
    schema_version: "decomposition-aggregate-summary-v1",
    policy: "Aggregate only sanitized per-cell stress/coherence metrics. No case text, case IDs, task paths, model outputs, or source quotes are emitted.",
    aggregate,
    cells,
    interpretation: "Expanded stress summary for parsing/chunking policies on deliberately hard exact-provenance misses. Metrics are lexical/span-support diagnostics, not semantic entailment, population estimates, or clinical correctness claims.",
  };
}

function methodSummary(report, method) {
  return (report.summary?.methods || []).find((item) => item.method === method) || {};
}

function renderMarkdown(summary) {
  const aggregate = summary.aggregate;
  const lines = [
    "# Decomposition Aggregate Summary",
    "",
    summary.interpretation,
    "",
    "## Aggregate",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Tasks | ${aggregate.tasks} |`,
    `| Query-aware supported | ${aggregate.query_aware_supported_tasks} (${formatPercent(aggregate.query_aware_support_rate)}) |`,
    `| Auto-accepted supports | ${aggregate.auto_accepted_supported_tasks} (${formatPercent(aggregate.auto_accept_rate)}) |`,
    `| Review-required supports | ${aggregate.review_required_supported_tasks} (${formatPercent(aggregate.review_required_rate)}) |`,
    `| Abstentions | ${aggregate.abstained_tasks} (${formatPercent(aggregate.abstention_rate)}) |`,
    `| High-risk supported | ${aggregate.high_risk_supported_tasks} |`,
    `| Normalized full-note supported | ${aggregate.normalized_supported_tasks} (${formatPercent(aggregate.normalized_support_rate)}) |`,
    `| Line-span supported | ${aggregate.line_span_supported_tasks} (${formatPercent(aggregate.line_span_support_rate)}) |`,
    `| Section-filtered supported | ${aggregate.section_filtered_supported_tasks} (${formatPercent(aggregate.section_filtered_support_rate)}) |`,
    `| Mean query-aware context words, supported | ${formatNumber(aggregate.mean_query_context_words_supported)} |`,
    "",
    "## Cells",
    "",
    "| Cell | Tasks | Query-aware | Auto-accepted | Review-required | Abstained |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const cell of summary.cells) {
    lines.push(`| ${cell.label} | ${cell.tasks} | ${cell.query_aware_supported_tasks} | ${cell.auto_accepted_supported_tasks} | ${cell.review_required_supported_tasks} | ${cell.unsupported_tasks} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parsePathList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCounts(collections) {
  const counts = {};
  for (const collection of collections) {
    for (const [key, value] of Object.entries(collection || {})) {
      counts[key] = (counts[key] || 0) + number(value);
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function weightedMean(items) {
  const valid = items.filter((item) => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0);
  const weight = sum(valid.map((item) => item.weight));
  return weight ? round(sum(valid.map((item) => item.value * item.weight)) / weight) : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

function ratio(numerator, denominator) {
  return denominator ? round(numerator / denominator) : null;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function formatPercent(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "N/A" : Number(value).toFixed(1);
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

module.exports = {
  summarizeDecompositionReports,
  renderMarkdown,
};
