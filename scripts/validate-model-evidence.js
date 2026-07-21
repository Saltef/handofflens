#!/usr/bin/env node

const fs = require("node:fs");

const PROVIDER_ERROR_PATTERNS = [
  /Missing\s+(COHERE|OPENROUTER)_API_KEY/i,
  /\b401\b/,
  /\b403\b/,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /provider_error/i,
  /invalid api key/i,
];

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = validateModelEvidence(payload, {
    requireProvider: args["require-provider"],
    requireModel: args["require-model"],
    requireScored: Boolean(args["require-scored"]),
    allowRepairs: Boolean(args["allow-repairs"]),
  });

  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.valid) {
    for (const issue of report.issues) console.error(`${issue.code}: ${issue.message}`);
    process.exitCode = 1;
  }
}

function validateModelEvidence(payload, options = {}) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const selected = filterResults(results, options);
  const issues = [];

  if (!results.length) issue(issues, "no_results", "Evaluation payload contains no result rows.");
  if (!selected.length) issue(issues, "no_selected_results", "No result rows matched the requested provider/model filters.");

  for (const row of selected) validateResultRow(row, issues, options);

  const summaryIssues = validateSummary(payload.summary || {}, selected, options);
  issues.push(...summaryIssues);

  const failedRows = selected.filter((row) => row.error);
  const completedRows = selected.filter((row) => !row.error && row.extraction);
  const providerErrorRows = selected.filter((row) => rowHasProviderError(row));
  const repairedRows = selected.filter((row) => row.raw_schema_valid === false || (row.schema_repairs || []).length > 0);
  const scoredRows = selected.filter((row) => !row.error && row.extraction && row.score && row.score.overall && Number.isFinite(Number(row.score.overall.f1)));

  return {
    generated_at: new Date().toISOString(),
    schema_version: "model-evidence-validity-v1",
    valid: issues.length === 0,
    summary: {
      total_rows: results.length,
      selected_rows: selected.length,
      completed_rows: completedRows.length,
      failed_rows: failedRows.length,
      provider_error_rows: providerErrorRows.length,
      repaired_or_normalized_rows: repairedRows.length,
      scored_rows: scoredRows.length,
      filters: {
        require_provider: options.requireProvider || null,
        require_model: options.requireModel || null,
        require_scored: Boolean(options.requireScored),
        allow_repairs: Boolean(options.allowRepairs),
      },
      issue_count: issues.length,
    },
    issues,
    interpretation: "A valid model-evidence run requires real provider completions for the selected rows. Missing credentials, authorization failures, row errors, zero completed cases, and unreported provider failures invalidate model-performance claims.",
  };
}

function validateResultRow(row, issues, options) {
  const label = `${row.model || "unknown-model"} ${row.case_id || "unknown-case"}`;
  if (row.error) issue(issues, "row_error", `${label} has row error: ${row.error}`, row);
  if (!row.extraction) issue(issues, "missing_extraction", `${label} has no extraction payload.`, row);
  if (!Array.isArray(row.attempt_audit) || !row.attempt_audit.length) issue(issues, "missing_attempt_audit", `${label} has no attempt audit.`, row);
  if (rowHasProviderError(row)) issue(issues, "provider_error", `${label} contains missing-key, authorization, or provider-error evidence.`, row);
  if (!options.allowRepairs && (row.raw_schema_valid === false || (row.schema_repairs || []).length > 0)) {
    issue(issues, "schema_repaired", `${label} required schema normalization or repair; report separately or rerun with --allow-repairs.`, row);
  }
  if (options.requireScored && !(row.score && row.score.overall && Number.isFinite(Number(row.score.overall.f1)))) {
    issue(issues, "missing_score", `${label} is not scored against gold labels.`, row);
  }
}

function validateSummary(summary, selected, options) {
  const issues = [];
  const models = [...new Set(selected.map((row) => row.model).filter(Boolean))];
  for (const model of models) {
    const modelRows = selected.filter((row) => row.model === model);
    const stats = summary[model];
    if (!stats) {
      issue(issues, "missing_summary", `Summary is missing model key ${model}.`);
      continue;
    }
    if (!(stats.cases_attempted > 0)) issue(issues, "zero_attempted", `${model} has zero attempted cases in summary.`);
    if (stats.cases_completed !== stats.cases_attempted) {
      issue(issues, "incomplete_cases", `${model} completed ${stats.cases_completed} of ${stats.cases_attempted} attempted cases.`);
    }
    if (stats.failures !== 0) issue(issues, "summary_failures", `${model} has ${stats.failures} summary failures.`);
    if (options.requireScored && !(stats.cases_scored > 0)) issue(issues, "zero_scored", `${model} has zero scored cases.`);
    const rowFailures = modelRows.filter((row) => row.error).length;
    if (rowFailures !== stats.failures) {
      issue(issues, "summary_row_mismatch", `${model} summary failures (${stats.failures}) do not match selected row errors (${rowFailures}).`);
    }
  }
  return issues;
}

function filterResults(results, options) {
  return results.filter((row) => {
    if (options.requireProvider && row.provider !== options.requireProvider) return false;
    if (options.requireModel && row.model !== options.requireModel) return false;
    return true;
  });
}

function rowHasProviderError(row) {
  const haystack = [
    row.error,
    row.fallbackReason,
    row.provider_error,
    ...(Array.isArray(row.attempt_audit) ? row.attempt_audit.flatMap((attempt) => [
      attempt.status === "failure" ? "attempt_failure" : "",
      attempt.error,
      attempt.telemetry?.status,
      attempt.telemetry?.error,
    ]) : []),
  ].filter(Boolean).join("\n");
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(haystack));
}

function issue(issues, code, message, row = null) {
  issues.push({
    code,
    message,
    case_id: row?.case_id || null,
    model: row?.model || null,
    route_model: row?.route_model || null,
  });
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

module.exports = { validateModelEvidence };
