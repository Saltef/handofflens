#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { classifyTypedProvenance } = require("./typed-provenance");
const { flattenEvidence, recordsFromPayload } = require("./analyze-lexical-overstatement");

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-typed-provenance.json");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = analyzeTypedProvenance(payload);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeTypedProvenance(payload) {
  const records = recordsFromPayload(payload);
  const cases = records.map(analyzeRecord);
  const items = cases.flatMap((item) => item.items);
  return {
    generated_at: new Date().toISOString(),
    schema_version: "typed-provenance-analysis-v1",
    summary: {
      records: records.length,
      evidence_items: items.length,
      type_counts: countBy(items.map((item) => item.provenance_type)),
      assertion_status_counts: countBy(items.map((item) => item.assertion_status)),
      domain_type_counts: domainTypeCounts(items),
    },
    cases,
    interpretation: "Automated proxy analysis. Typed provenance separates direct lexical support, supported normalization, inferential support, unsupported labels, and assertion conflicts. It does not establish clinical correctness.",
  };
}

function analyzeRecord(record) {
  const sourceText = String(record.source_text || record.source || record.discharge_summary || record.case?.discharge_summary || "");
  const items = flattenEvidence(record.extraction || {}).map((item) => {
    const provenance = classifyTypedProvenance({ sourceText, label: item.label, quote: item.source_quote, domain: item.path });
    return {
      case_id: String(record.case_id || ""),
      path: item.path,
      label: String(item.label || ""),
      source_quote: String(item.source_quote || ""),
      provenance_type: provenance.type,
      assertion_status: provenance.assertion_status,
      quote_found_in_source: provenance.quote_found_in_source,
      token_overlap: provenance.details.token_overlap,
    };
  });
  return {
    case_id: String(record.case_id || ""),
    evidence_items: items.length,
    type_counts: countBy(items.map((item) => item.provenance_type)),
    items,
  };
}

function domainTypeCounts(items) {
  const counts = {};
  for (const item of items) {
    const domain = broadDomain(item.path);
    counts[domain] ||= {};
    counts[domain][item.provenance_type] = (counts[domain][item.provenance_type] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([domain, value]) => [domain, Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))]));
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

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
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

module.exports = { analyzeTypedProvenance };
