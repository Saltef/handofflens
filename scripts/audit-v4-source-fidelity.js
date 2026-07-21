#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { validateEvidenceSemantics } = require("./clinical-validation-signals");

const args = parseArgs(process.argv.slice(2));
const input = args.input || "results/candidate-first-v4-final20-20260623/combined.json";
const outJson = args.out || input.replace(/\.json$/i, "-source-fidelity-audit.json");
const outMd = args.md || outJson.replace(/\.json$/i, ".md");
const failOnIssue = Boolean(args["fail-on-issue"]);

const payload = JSON.parse(fs.readFileSync(input, "utf8"));
const records = Array.isArray(payload.records) ? payload.records : [];
const audits = records.map((record) => {
  const semantic = validateEvidenceSemantics(record.extraction, { sourceText: record.source_text || record.source || record.discharge_summary || record.case?.discharge_summary });
  const quoteIssues = quoteCompletenessIssues(record);
  const issues = [...semantic.issues, ...quoteIssues];
  return {
    case_id: record.case_id,
    success: Boolean(record.success),
    abstained: Boolean(record.abstention?.required),
    valid: issues.length === 0,
    issue_count: issues.length,
    issues,
  };
});

const issueCounts = countBy(audits.flatMap((audit) => audit.issues.map((issue) => issue.code)));
const summary = {
  input,
  records: records.length,
  passed_records: audits.filter((audit) => audit.valid).length,
  records_with_issues: audits.filter((audit) => !audit.valid).length,
  abstained_records: audits.filter((audit) => audit.abstained).length,
  issue_counts: issueCounts,
  interpretation:
    "Deterministic source-fidelity proxy only. Passing this audit does not prove clinical correctness or completeness.",
};

writeJson(outJson, { summary, audits });
fs.writeFileSync(outMd, renderMarkdown(summary, audits));
console.log(JSON.stringify(summary, null, 2));
if (failOnIssue && summary.records_with_issues > 0) process.exitCode = 1;

function quoteCompletenessIssues(record) {
  const issues = [];
  for (const [listPath, list] of evidenceLists(record.extraction)) {
    for (const [index, item] of list.entries()) {
      const quote = String(item.source_quote || "");
      const label = String(item.label || "");
      if (!quote.trim()) {
        issues.push({ code: "empty_source_quote", path: `${listPath}[${index}]` });
        continue;
      }
      if (quote.length < Math.min(18, label.length) && label.length > quote.length + 10) {
        issues.push({
          code: "source_quote_may_be_incomplete",
          path: `${listPath}[${index}]`,
          details: { label_length: label.length, quote_length: quote.length },
        });
      }
      const labelTokens = contentTokens(label);
      const quoteTokenSet = new Set(contentTokens(quote));
      const missing = labelTokens.filter((token) => !quoteTokenSet.has(token));
      const missingRate = labelTokens.length ? missing.length / labelTokens.length : 0;
      if (labelTokens.length >= 4 && missingRate > 0.4) {
        issues.push({
          code: "label_not_extractively_supported_by_quote",
          path: `${listPath}[${index}]`,
          details: { missing_terms: missing.slice(0, 12), missing_rate: Number(missingRate.toFixed(3)) },
        });
      }
    }
  }
  return issues;
}

function evidenceLists(extraction) {
  const lists = [];
  const meds = extraction?.medication_changes || {};
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) {
    lists.push([`medication_changes.${key}`, Array.isArray(meds[key]) ? meds[key] : []]);
  }
  const diagnoses = extraction?.diagnosis_changes || {};
  lists.push(["diagnosis_changes.discharge", Array.isArray(diagnoses.discharge) ? diagnoses.discharge : []]);
  lists.push(["diagnosis_changes.new_or_changed", Array.isArray(diagnoses.new_or_changed) ? diagnoses.new_or_changed : []]);
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) {
    lists.push([key, Array.isArray(extraction?.[key]) ? extraction[key] : []]);
  }
  return lists;
}

function contentTokens(value) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "were",
    "was",
    "are",
    "patient",
    "discharge",
    "continued",
    "started",
    "changed",
    "stopped",
    "tablet",
    "capsule",
  ]);
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stop.has(token));
}

function renderMarkdown(summary, audits) {
  const lines = [
    "# Candidate-first v4 source-fidelity audit",
    "",
    "This is an automated proxy audit for quote support. It is intentionally narrower than human factual review and does not establish clinical correctness.",
    "",
    "## Summary",
    "",
    `- Input: \`${summary.input}\``,
    `- Records: ${summary.records}`,
    `- Passed records: ${summary.passed_records}`,
    `- Records with issues: ${summary.records_with_issues}`,
    `- Abstained records: ${summary.abstained_records}`,
    "",
    "## Issue counts",
    "",
  ];
  if (Object.keys(summary.issue_counts).length === 0) lines.push("- None");
  else for (const [code, count] of Object.entries(summary.issue_counts)) lines.push(`- ${code}: ${count}`);
  const affected = audits.filter((audit) => !audit.valid);
  if (affected.length) {
    lines.push("", "## Affected cases", "");
    for (const audit of affected) {
      lines.push(`### ${audit.case_id}`, "");
      for (const issue of audit.issues.slice(0, 20)) {
        lines.push(`- ${issue.path || "record"}: ${issue.code}`);
      }
      if (audit.issues.length > 20) lines.push(`- ... ${audit.issues.length - 20} additional issues`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
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
