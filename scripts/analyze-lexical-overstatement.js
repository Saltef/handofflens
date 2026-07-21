#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { detectAssertionStatus } = require("./clinical-validation-signals");

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-lexical-overstatement.json");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = analyzeLexicalOverstatement(payload);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeLexicalOverstatement(payload) {
  const records = recordsFromPayload(payload);
  const caseReports = records.map(analyzeRecord);
  const items = caseReports.flatMap((record) => record.items);
  const withSource = items.filter((item) => item.has_source_text);
  const lexicallyLocated = withSource.filter((item) => item.quote_found_in_source);
  const assertionConflicts = lexicallyLocated.filter((item) => item.assertion_status !== "present" && !item.label_acknowledges_assertion);
  const byStatus = countBy(assertionConflicts.map((item) => item.assertion_status));
  const byDomain = countBy(assertionConflicts.map((item) => item.domain));
  return {
    generated_at: new Date().toISOString(),
    schema_version: "lexical-provenance-overstatement-v1",
    summary: {
      records: records.length,
      evidence_items: items.length,
      items_with_source_text: withSource.length,
      lexically_located_items: lexicallyLocated.length,
      assertion_conflict_items: assertionConflicts.length,
      lexical_overstatement_rate: ratio(assertionConflicts.length, lexicallyLocated.length),
      conflict_status_counts: byStatus,
      conflict_domain_counts: byDomain,
    },
    cases: caseReports,
    interpretation: "Automated proxy metric: among evidence items whose quote is lexically found in source text, estimate how often the local assertion context is not present and the label does not acknowledge that status. This does not establish clinical correctness.",
  };
}

function recordsFromPayload(payload) {
  if (Array.isArray(payload.records)) return payload.records;
  if (!Array.isArray(payload.results)) return [];
  const casesById = loadCasesById(payload.cases_path);
  return payload.results.map((result) => {
    const testCase = casesById.get(String(result.case_id || ""));
    return {
      ...result,
      success: !result.error && Boolean(result.extraction),
      source_text: result.source_text || result.discharge_summary || testCase?.discharge_summary || "",
      case: testCase || null,
    };
  });
}

function loadCasesById(casesPath) {
  const out = new Map();
  if (!casesPath || !fs.existsSync(casesPath)) return out;
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  if (!Array.isArray(cases)) return out;
  for (const testCase of cases) out.set(String(testCase.case_id || ""), testCase);
  return out;
}

function analyzeRecord(record) {
  const sourceText = getSourceText(record);
  const items = flattenEvidence(record.extraction || {}).map((item) => {
    const assertion = detectAssertionStatus({ sourceText, quote: item.source_quote, label: item.label });
    return {
      case_id: String(record.case_id || ""),
      path: item.path,
      domain: broadDomain(item.path),
      label: String(item.label || ""),
      assertion_status: assertion.status,
      quote_found_in_source: assertion.quote_found_in_source,
      has_source_text: Boolean(sourceText),
      label_acknowledges_assertion: labelAcknowledgesAssertion(item.label, assertion.status),
      context_window: assertion.context_window,
    };
  });
  return {
    case_id: String(record.case_id || ""),
    success: Boolean(record.success),
    abstained: Boolean(record.abstention?.required),
    evidence_items: items.length,
    lexically_located_items: items.filter((item) => item.quote_found_in_source).length,
    assertion_conflict_items: items.filter((item) => item.quote_found_in_source && item.assertion_status !== "present" && !item.label_acknowledges_assertion).length,
    items,
  };
}

function flattenEvidence(extraction) {
  const out = [];
  const meds = extraction.medication_changes || {};
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) {
    for (const [index, item] of array(meds[key]).entries()) out.push({ ...item, path: `medication_changes.${key}[${index}]` });
  }
  const diagnoses = extraction.diagnosis_changes || {};
  for (const [index, item] of array(diagnoses.discharge).entries()) out.push({ ...item, path: `diagnosis_changes.discharge[${index}]` });
  for (const [index, item] of array(diagnoses.new_or_changed).entries()) out.push({ ...item, path: `diagnosis_changes.new_or_changed[${index}]` });
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items", "handoff_atoms"]) {
    for (const [index, item] of array(extraction[key]).entries()) out.push({ ...item, path: `${key}[${index}]` });
  }
  return out;
}

function getSourceText(record) {
  return String(record.source_text || record.source || record.discharge_summary || record.case?.discharge_summary || "");
}

function broadDomain(pathValue) {
  const value = String(pathValue || "");
  if (value.startsWith("medication_changes")) return "medication";
  if (value.startsWith("diagnosis_changes")) return "diagnosis";
  if (value.startsWith("procedures_and_tests")) return "procedure_or_test";
  if (value.startsWith("labs")) return "lab";
  if (value.startsWith("follow_up_actions")) return "follow_up";
  if (value.startsWith("safety_flags")) return "safety";
  if (value.startsWith("uncertain_items")) return "uncertain";
  if (value.startsWith("handoff_atoms")) return "atom";
  return "other";
}

function labelAcknowledgesAssertion(label, status) {
  const text = String(label || "").toLowerCase();
  if (status === "present") return true;
  if (status === "absent") return /\b(?:no|negative|denied|ruled out|absent|without)\b/.test(text);
  if (status === "possible") return /\b(?:possible|probable|suspected|concern|rule out|cannot exclude|uncertain)\b/.test(text);
  if (status === "conditional") return /\b(?:if|when|monitor|return for|conditional)\b/.test(text);
  if (status === "hypothetical") return /\b(?:risk|consider|planned|hypothetical)\b/.test(text);
  if (status === "historical") return /\b(?:history|prior|previous|remote|resolved|status post|s\/p)\b/.test(text);
  if (status === "associated_with_someone_else") return /\b(?:family history|mother|father|sister|brother|son|daughter|wife|husband)\b/.test(text);
  return false;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
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

module.exports = { analyzeLexicalOverstatement, flattenEvidence, recordsFromPayload };
