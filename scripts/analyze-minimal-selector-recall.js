#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runDecompositionStressExperiment } = require("./run-decomposition-stress-experiment");
const { selectMinimalEvidence } = require("./minimal-evidence-selector");
const { rateSummary, formatRate, countBy, mean, round } = require("./experiment-metrics");

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const casesPath = required(args.cases, "--cases is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-minimal-selector-recall.json");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const report = analyzeMinimalSelectorRecall(payload, {
    inputPath,
    casesPath,
    cases,
    taskLimit: Number(args["task-limit"] || 10000),
    caseLimit: Number(args["case-limit"] || 20),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(args.mdout || outPath.replace(/\.json$/i, ".md"), renderMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeMinimalSelectorRecall(payload, options = {}) {
  const stress = runDecompositionStressExperiment(payload, {
    inputPath: options.inputPath,
    casesPath: options.casesPath,
    cases: options.cases,
    taskLimit: options.taskLimit || 10000,
    caseLimit: options.caseLimit || 20,
  });
  const sourceByCase = sourceTextByCase(payload, options.cases || []);
  const items = stress.tasks.map((task) => {
    const sourceText = sourceByCase.get(task.case_id) || "";
    const oldPolicy = task.methods.query_aware_multispan;
    const selector = selectMinimalEvidence(sourceText, task, { maxSpans: 3, granularity: "clause" });
    const oldSupported = Boolean(oldPolicy?.supported);
    const newSupported = Boolean(selector.supported);
    const recallLost = oldSupported && !newSupported;
    return {
      case_id: task.case_id,
      path: task.path,
      domain: task.domain,
      miss_category: task.miss_category,
      old_supported: oldSupported,
      old_status: oldPolicy?.status || null,
      old_selected_span_count: oldPolicy?.selected_span_count || 0,
      old_selected_context_words: oldPolicy?.selected_context_words || 0,
      new_supported: newSupported,
      new_support_status: selector.support_status,
      new_selected_span_count: selector.selected_span_count,
      new_selected_context_words: selector.selected_context_words,
      recall_lost: recallLost,
      recall_loss_category: recallLost ? classifyRecallLoss(task, oldPolicy, selector) : null,
      recall_loss_features: recallLost ? recallLossFeatures(task, oldPolicy, selector) : [],
    };
  });
  const oldSupported = items.filter((item) => item.old_supported);
  const newSupported = items.filter((item) => item.new_supported);
  const recallLost = items.filter((item) => item.recall_lost);
  const oldOnlyDenominator = oldSupported.length;
  return {
    generated_at: new Date().toISOString(),
    schema_version: "minimal-selector-recall-v1",
    unit: "failed exact-provenance evidence item",
    task_selection: stress.task_selection,
    summary: {
      tasks: items.length,
      source_records: new Set(items.map((item) => item.case_id)).size,
      old_query_aware_support: rateSummary(oldSupported.length, items.length),
      minimal_selector_support: rateSummary(newSupported.length, items.length),
      old_supported_retained_by_minimal_selector: rateSummary(oldSupported.filter((item) => item.new_supported).length, oldOnlyDenominator),
      recall_cost_among_old_supported: rateSummary(recallLost.length, oldOnlyDenominator),
      recall_loss_categories: countBy(recallLost.map((item) => item.recall_loss_category)),
      recall_loss_features: countBy(recallLost.flatMap((item) => item.recall_loss_features)),
      minimal_selector_support_status_counts: countBy(items.map((item) => item.new_support_status)),
      mean_context_words: {
        old_query_aware_supported: round(mean(oldSupported.map((item) => item.old_selected_context_words))),
        minimal_selector_supported: round(mean(newSupported.map((item) => item.new_selected_context_words))),
      },
      mean_selected_spans: {
        old_query_aware_supported: round(mean(oldSupported.map((item) => item.old_selected_span_count))),
        minimal_selector_supported: round(mean(newSupported.map((item) => item.new_selected_span_count))),
      },
    },
    items,
    interpretation: "Compares the prior adaptive query-aware support policy against the risk-aware minimal sufficient evidence selector on the same selected failed exact-provenance items. Recall cost means items supported by the old policy that the minimal selector routes to insufficient/not_found. This is lexical/span auditability, not semantic entailment or clinical correctness.",
  };
}

function sourceTextByCase(payload, cases) {
  const byCase = new Map(cases.map((testCase) => [String(testCase.case_id || ""), String(testCase.discharge_summary || "")]));
  for (const result of payload.results || []) {
    const caseId = String(result.case_id || "");
    const source = result.source_text || result.discharge_summary;
    if (caseId && source && !byCase.has(caseId)) byCase.set(caseId, String(source));
  }
  for (const record of payload.records || []) {
    const caseId = String(record.case_id || "");
    const source = record.source_text || record.discharge_summary || record.case?.discharge_summary;
    if (caseId && source && !byCase.has(caseId)) byCase.set(caseId, String(source));
  }
  return byCase;
}

function classifyRecallLoss(task, oldPolicy, selector) {
  if (selector.rejected_counts?.assertion_conflict) return "blocked_by_assertion_conflict";
  if (selector.rejected_counts?.label_risk) return "blocked_by_budget_normalized_label_risk";
  if (/^query_label_/.test(oldPolicy?.status || "")) return "old_policy_label_only_support";
  if ((oldPolicy?.selected_span_count || 0) > 3) return "old_policy_exceeded_span_cap";
  if (task.miss_category === "normalization_or_punctuation") return "normalization_needed";
  if (task.miss_category === "label_supported_quote_unresolved") return "label_supported_quote_unresolved";
  if (selector.selected_span_count > 0) return "coverage_below_threshold_after_selection";
  return "no_minimal_candidate_found";
}

function recallLossFeatures(task, oldPolicy, selector) {
  const features = [];
  const oldSpans = oldPolicy?.selected_spans || [];
  const sections = new Set(oldSpans.map((span) => span.section).filter(Boolean));
  if (sections.size > 1) features.push("cross_section_reasoning");
  if ((oldPolicy?.selected_span_count || 0) > 1) features.push("multi_span_composition");
  if (/^query_label_/.test(oldPolicy?.status || "")) features.push("label_only_old_support");
  if (selector.rejected_counts?.assertion_conflict) features.push("assertion_sensitive");
  if (selector.rejected_counts?.label_risk) features.push("label_risk_sensitive");
  if (["label_supported_quote_unresolved", "weak_overlap_needs_review"].includes(task.miss_category)) features.push("implicit_or_weak_source_link");
  if (task.miss_category === "normalization_or_punctuation") features.push("normalization_sensitive");
  return features.length ? features : ["coverage_selection_gap"];
}

function renderMarkdown(report) {
  const lines = [
    "# Minimal Selector Recall Cost",
    "",
    report.interpretation,
    "",
    "## Summary",
    "",
    `Unit: ${report.unit}`,
    `Tasks: ${report.summary.tasks}`,
    `Source records: ${report.summary.source_records}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Old query-aware support | ${formatRate(report.summary.old_query_aware_support)} |`,
    `| Minimal selector support | ${formatRate(report.summary.minimal_selector_support)} |`,
    `| Old supported retained by minimal selector | ${formatRate(report.summary.old_supported_retained_by_minimal_selector)} |`,
    `| Recall cost among old supported | ${formatRate(report.summary.recall_cost_among_old_supported)} |`,
    "",
    "## Recall-Loss Categories",
    "",
    "| Category | Items |",
    "| --- | ---: |",
  ];
  for (const [category, count] of Object.entries(report.summary.recall_loss_categories)) {
    lines.push(`| \`${category}\` | ${count} |`);
  }
  lines.push("", "## Recall-Loss Features", "", "| Feature | Items |", "| --- | ---: |");
  for (const [feature, count] of Object.entries(report.summary.recall_loss_features)) {
    lines.push(`| \`${feature}\` | ${count} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

module.exports = { analyzeMinimalSelectorRecall, renderMarkdown };
