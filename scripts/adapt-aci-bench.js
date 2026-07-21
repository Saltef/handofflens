#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadProfile } = require("./profile-config");

function parseArgs(argv) {
  const args = {
    out: "eval/aci_bench_records.json",
    "dataset-id": "aci_bench",
    split: "unknown",
    "profile-id": "clinical-dialogue",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function adaptAciBenchRows(rows, options = {}) {
  const datasetId = options.datasetId || "aci_bench";
  const split = options.split || "unknown";
  const profileId = options.profileId || "clinical-dialogue";
  loadProfile(profileId);

  const records = [];
  const issues = [];
  rows.forEach((row, index) => {
    const recordId = firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id"]) || `${datasetId}:${split}:${index + 1}`;
    const sourceText = firstValue(row, ["source_text", "dialogue", "conversation", "transcript", "src", "input", "text"]);
    const referenceText = firstValue(row, ["reference_text", "reference_note", "note", "clinical_note", "target", "tgt", "summary"]);
    if (!sourceText) {
      issues.push({ row_index: index, record_id: recordId, issue: "missing_source_text" });
      return;
    }
    const goldItems = normalizeGoldItems(row.gold_items || row.expected_items || row.labels || [], String(recordId));
    records.push({
      record_id: String(recordId),
      source_text: String(sourceText),
      reference_text: referenceText ? String(referenceText) : "",
      metadata: {
        dataset_id: datasetId,
        split,
        profile_id: profileId,
        reference_text_sha256: referenceText ? sha256(String(referenceText)) : null,
        adapter: "adapt-aci-bench-v1",
      },
      gold_items: goldItems,
    });
  });

  return {
    schema_version: "handofflens-records-v1",
    dataset_id: datasetId,
    adapter: {
      name: "adapt-aci-bench",
      version: "adapt-aci-bench-v1",
      profile_id: profileId,
      split,
      caveat: "ACI-Bench supplies conversations and reference notes; item-level extraction scoring requires gold_items supplied by a downstream annotation or derivation step.",
    },
    records,
    issues,
    summary: {
      rows_seen: rows.length,
      records_emitted: records.length,
      records_with_reference_text: records.filter((record) => record.reference_text).length,
      records_with_gold_items: records.filter((record) => record.gold_items.length).length,
    },
  };
}

function readRows(inputPath) {
  const text = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (ext === ".csv" || ext === ".tsv") return parseDelimited(text, ext === ".tsv" ? "\t" : ",");
  const payload = JSON.parse(text);
  if (Array.isArray(payload)) return payload;
  for (const key of ["records", "rows", "data", "examples"]) if (Array.isArray(payload[key])) return payload[key];
  throw new Error(`Unsupported JSON shape in ${inputPath}; expected array or records/rows/data/examples array`);
}

function parseDelimited(text, delimiter) {
  const rows = parseCsvRows(text, delimiter);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).filter((row) => row.some((cell) => cell.trim())).map((row) => {
    const out = {};
    headers.forEach((header, index) => { out[header] = row[index] || ""; });
    return out;
  });
}

function parseCsvRows(text, delimiter = ",") {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.length > 1 || row[0]) rows.push(row);
  return rows;
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) return row[key];
  }
  const lower = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    if (lower[key] !== undefined && String(lower[key]).trim()) return lower[key];
  }
  return "";
}

function normalizeGoldItems(value, recordId) {
  const items = Array.isArray(value) ? value : tryJsonArray(value);
  return items.map((item, index) => ({
    item_id: String(item.item_id || item.gold_id || `${recordId}:G${index + 1}`),
    domain: String(item.domain || item.category || "unknown"),
    label: String(item.label || item.text || item.description || ""),
    source_quote: String(item.source_quote || item.quote || ""),
    assertion_status: String(item.assertion_status || "unknown"),
    span: normalizeSpan(item.span),
    relations: Array.isArray(item.relations) ? item.relations : [],
  })).filter((item) => item.label || item.source_quote);
}

function tryJsonArray(value) {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSpan(span) {
  if (!span || typeof span !== "object") return null;
  const start = Number(span.start);
  const end = Number(span.end);
  return Number.isInteger(start) && Number.isInteger(end) && end >= start ? { start, end } : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("--input is required");
    process.exit(1);
  }
  const report = adaptAciBenchRows(readRows(args.input), {
    datasetId: args["dataset-id"],
    split: args.split,
    profileId: args["profile-id"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.issues.length) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { adaptAciBenchRows, parseCsvRows, readRows };