#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { hasAssertionCueConflict } = require("./assertion-cue-scope");

const args = parseArgs(process.argv.slice(2));

const QUERY_METHOD = "query_aware_multispan";
const DEFAULT_CONTEXT_WORD_WARNING = 60;
const DEFAULT_LINE_WINDOW_WARNING = 40;

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-coherence-audit.json");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = auditDecompositionCoherence(payload, {
    inputPath,
    contextWordWarning: Number(args["context-word-warning"] || DEFAULT_CONTEXT_WORD_WARNING),
    lineWindowWarning: Number(args["line-window-warning"] || DEFAULT_LINE_WINDOW_WARNING),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(args.mdout || outPath.replace(/\.json$/i, ".md"), renderMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}

function auditDecompositionCoherence(payload, options = {}) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const audited = tasks
    .map((task) => auditTask(task, options))
    .filter(Boolean);
  const supported = audited.filter((item) => item.supported);
  const highRisk = supported.filter((item) => item.risk_level === "high");
  const mediumRisk = supported.filter((item) => item.risk_level === "medium");
  const lowRisk = supported.filter((item) => item.risk_level === "low");
  const lowOverlapSupported = supported.filter((item) => item.flags.low_overlap_supported);
  const labelOnly = supported.filter((item) => item.flags.label_only_support);
  const assertionConflicts = supported.filter((item) => item.flags.assertion_cue_conflict);

  return {
    generated_at: new Date().toISOString(),
    schema_version: "decomposition-coherence-audit-v1",
    input_path: options.inputPath || "",
    summary: {
      tasks: tasks.length,
      supported_tasks: supported.length,
      unsupported_tasks: audited.filter((item) => !item.supported).length,
      high_risk_supported_tasks: highRisk.length,
      medium_risk_supported_tasks: mediumRisk.length,
      low_risk_supported_tasks: lowRisk.length,
      auto_accepted_supported_tasks: lowRisk.length,
      review_required_supported_tasks: mediumRisk.length,
      blocked_supported_tasks: highRisk.length,
      low_overlap_supported_tasks: lowOverlapSupported.length,
      label_only_supported_tasks: labelOnly.length,
      assertion_cue_conflict_tasks: assertionConflicts.length,
      multi_span_supported_tasks: supported.filter((item) => item.selected_span_count > 1).length,
      cross_section_supported_tasks: supported.filter((item) => item.flags.cross_section_union).length,
      wide_window_supported_tasks: supported.filter((item) => item.flags.wide_span_window).length,
      many_span_supported_tasks: supported.filter((item) => item.flags.many_spans).length,
      supported_by_status: countBy(supported.map((item) => item.status)),
      high_risk_reasons: countReasons(highRisk),
      medium_risk_reasons: countReasons(mediumRisk),
    },
    thresholds: {
      context_word_warning: Number(options.contextWordWarning || DEFAULT_CONTEXT_WORD_WARNING),
      line_window_warning: Number(options.lineWindowWarning || DEFAULT_LINE_WINDOW_WARNING),
      high_confidence_quote_coverage: 0.86,
    },
    interpretation: "Coherence audit for query-aware decomposition recovery. It flags possible stitching risks in supported span unions. Risk flags are review-priority signals, not factuality labels or clinical judgments.",
    tasks: audited,
  };
}

function auditTask(task, options = {}) {
  const method = task?.methods?.[QUERY_METHOD];
  if (!method) return null;
  const spans = Array.isArray(method.selected_spans) ? method.selected_spans : [];
  const ordinals = spans.map((span) => ordinalFromSpanId(span.span_id)).filter(Number.isFinite);
  const sections = [...new Set(spans.map((span) => span.section || "unknown").filter((section) => section !== "unknown"))];
  const spanWindow = ordinals.length ? Math.max(...ordinals) - Math.min(...ordinals) + 1 : 0;
  const selectedText = spans.map((span) => span.text || "").join(" ");
  const label = String(task.label || "");
  const lowOverlap = task.prior_span_support_status === "abstain_low_overlap" || task.miss_category === "low_overlap_possible_fabrication";
  const labelOnly = /^query_label_/.test(method.status || "") || (
    method.supported
    && Number(method.combined_label_coverage || 0) >= 0.72
    && Number(method.combined_quote_coverage || 0) < 0.72
  );
  const lowOverlapReviewRescue = method.status === "query_low_overlap_review_supported";
  const assertionCueConflict = hasAssertionCueConflict(selectedText, label, task);
  const flags = {
    low_overlap_supported: Boolean(method.supported && lowOverlap && !lowOverlapReviewRescue),
    low_overlap_review_rescue: Boolean(method.supported && lowOverlapReviewRescue),
    label_only_support: Boolean(method.supported && labelOnly),
    assertion_cue_conflict: Boolean(method.supported && assertionCueConflict),
    cross_section_union: Boolean(method.supported && sections.length > 1),
    wide_span_window: Boolean(method.supported && spanWindow > Number(options.lineWindowWarning || DEFAULT_LINE_WINDOW_WARNING)),
    high_context_words: Boolean(method.supported && Number(method.selected_context_words || 0) > Number(options.contextWordWarning || DEFAULT_CONTEXT_WORD_WARNING)),
    many_spans: Boolean(method.supported && Number(method.selected_span_count || 0) > 3),
    low_quote_coverage: Boolean(method.supported && Number(method.combined_quote_coverage || 0) < 0.86),
  };
  const risk = classifyRisk(flags);
  return {
    case_id: String(task.case_id || ""),
    path: String(task.path || ""),
    domain: String(task.domain || ""),
    miss_category: String(task.miss_category || ""),
    prior_span_support_status: String(task.prior_span_support_status || ""),
    supported: Boolean(method.supported),
    status: String(method.status || ""),
    risk_level: method.supported ? risk.level : "not_supported",
    risk_reasons: method.supported ? risk.reasons : [],
    acceptance: acceptanceForRisk(method.supported, risk.level),
    selected_span_count: Number(method.selected_span_count || 0),
    selected_context_words: Number(method.selected_context_words || 0),
    span_window_lines: spanWindow,
    section_count: sections.length,
    combined_quote_coverage: Number(method.combined_quote_coverage || 0),
    combined_label_coverage: Number(method.combined_label_coverage || 0),
    flags,
  };
}

function classifyRisk(flags) {
  const reasons = Object.entries(flags).filter(([, value]) => value).map(([key]) => key);
  const highReasons = ["low_overlap_supported", "assertion_cue_conflict"];
  if (highReasons.some((reason) => flags[reason])) return { level: "high", reasons };
  if (flags.label_only_support && (flags.cross_section_union || flags.wide_span_window || flags.many_spans)) {
    return { level: "high", reasons };
  }
  if (flags.low_overlap_review_rescue || flags.cross_section_union || flags.wide_span_window || flags.high_context_words || flags.many_spans || flags.label_only_support) {
    return { level: "medium", reasons };
  }
  return { level: "low", reasons };
}

function acceptanceForRisk(supported, riskLevel) {
  if (!supported) return "abstain";
  if (riskLevel === "low") return "auto_accept";
  if (riskLevel === "medium") return "review_required";
  return "blocked_review";
}

function renderMarkdown(report) {
  const lines = [
    "# Decomposition Coherence Audit",
    "",
    report.interpretation,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Tasks | ${report.summary.tasks} |`,
    `| Query-aware supported tasks | ${report.summary.supported_tasks} |`,
    `| Low-risk supported tasks | ${report.summary.low_risk_supported_tasks} |`,
    `| Medium-risk supported tasks | ${report.summary.medium_risk_supported_tasks} |`,
    `| High-risk supported tasks | ${report.summary.high_risk_supported_tasks} |`,
    `| Auto-accepted supported tasks | ${report.summary.auto_accepted_supported_tasks} |`,
    `| Review-required supported tasks | ${report.summary.review_required_supported_tasks} |`,
    `| Blocked supported tasks | ${report.summary.blocked_supported_tasks} |`,
    `| Low-overlap supported tasks | ${report.summary.low_overlap_supported_tasks} |`,
    `| Assertion-cue conflict tasks | ${report.summary.assertion_cue_conflict_tasks} |`,
    `| Label-only supported tasks | ${report.summary.label_only_supported_tasks} |`,
    `| Cross-section supported tasks | ${report.summary.cross_section_supported_tasks} |`,
    `| Wide-window supported tasks | ${report.summary.wide_window_supported_tasks} |`,
    "",
    "## Supported Statuses",
    "",
    "| Status | Count |",
    "| --- | ---: |",
  ];
  for (const [status, count] of Object.entries(report.summary.supported_by_status)) {
    lines.push(`| \`${status}\` | ${count} |`);
  }
  lines.push("", "## High-Risk Reasons", "", "| Reason | Count |", "| --- | ---: |");
  for (const [reason, count] of Object.entries(report.summary.high_risk_reasons)) {
    lines.push(`| \`${reason}\` | ${count} |`);
  }
  lines.push("", "## Medium-Risk Reasons", "", "| Reason | Count |", "| --- | ---: |");
  for (const [reason, count] of Object.entries(report.summary.medium_risk_reasons)) {
    lines.push(`| \`${reason}\` | ${count} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function countReasons(items) {
  return countBy(items.flatMap((item) => item.risk_reasons || []));
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function ordinalFromSpanId(spanId) {
  const match = String(spanId || "").match(/^L0*([0-9]+)$/);
  return match ? Number(match[1]) : NaN;
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

module.exports = {
  auditDecompositionCoherence,
  hasAssertionCueConflict,
};
