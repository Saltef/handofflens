#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const input = args.input || "results/candidate-first-v4-final20-20260623/combined.json";
const outDir = path.resolve(root, args["out-dir"] || "results/candidate-first-v4-final20-20260623-extractive");
const base = JSON.parse(fs.readFileSync(path.resolve(root, input), "utf8"));
const records = (base.records || []).map((record) => rematerialize(record));
fs.mkdirSync(outDir, { recursive: true });
const output = {
  ...base,
  generated_at: new Date().toISOString(),
  source_results: [input],
  transformation:
    "Labels, rationales, and summaries deterministically rematerialized from accepted source quotations; categories and candidate selections unchanged.",
  records,
};
fs.writeFileSync(path.join(outDir, "combined.json"), `${JSON.stringify(output, null, 2)}\n`);
const evidenceItems = records.reduce((n, record) => n + (record.extraction ? lists(record.extraction).reduce((m, [, list]) => m + list.length, 0) : 0), 0);
console.log(JSON.stringify({ output: outDir, records: records.length, evidence_items: evidenceItems }, null, 2));

function rematerialize(record) {
  const out = structuredClone(record);
  if (!out.extraction) return out;
  for (const [, list] of lists(out.extraction)) {
    for (const item of list) {
      item.label = extractive(item.source_quote);
      item.rationale = "Extractive label copied from the source quotation.";
    }
  }
  out.extraction.two_page_summary = extractiveSummary(out.extraction);
  return out;
}
function lists(e) { return [...Object.entries(e.medication_changes || {}).map(([key, value]) => [`medication_changes.${key}`, value]), ["diagnosis_changes.discharge", e.diagnosis_changes?.discharge || []], ["diagnosis_changes.new_or_changed", e.diagnosis_changes?.new_or_changed || []], ...["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"].map((key) => [key, e[key] || []])]; }
function extractive(value) { return String(value || "").replace(/\s+/g, " ").replace(/^(?:\?{3,}|\d{1,2}[.)]|[-*])\s*/, "").trim().slice(0, 300); }
function extractiveSummary(extraction) {
  const sections = lists(extraction)
    .map(([name, list]) => {
      const labels = (Array.isArray(list) ? list : []).map((item) => extractive(item.source_quote)).filter(Boolean).slice(0, 8);
      return labels.length ? `${name}: ${labels.join("; ")}.` : "";
    })
    .filter(Boolean);
  if (!sections.length) return "";
  return sections.join(" ").slice(0, 4000);
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
