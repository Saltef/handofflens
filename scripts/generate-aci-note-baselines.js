#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readRows } = require("./adapt-aci-bench");

const BASELINE_METHODS = ["source_full", "lead_reference_length", "tail_reference_length", "cue_sentence_extractive"];

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-baseline-records.json",
    method: "tail_reference_length",
    "prediction-field": "generated_note",
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

function generateAciNoteBaselineRows(rows, options = {}) {
  const method = options.method || "tail_reference_length";
  const predictionField = options.predictionField || options["prediction-field"] || "generated_note";
  const tokenBudget = Number(options.tokenBudget ?? options["token-budget"]);
  if (!BASELINE_METHODS.includes(method)) throw new Error(`Unknown ACI note baseline method: ${method}`);

  const records = rows.map((row, index) => {
    const source = firstValue(row, ["source_text", "src", "dialogue", "conversation", "transcript", "input", "text"]);
    const reference = firstValue(row, ["reference_text", "reference_note", "note", "clinical_note", "target", "tgt", "summary"]);
    const budget = Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : Math.max(1, tokenCount(reference));
    const generated = generateNote(source, reference, { method, tokenBudget: budget });
    return {
      ...row,
      [predictionField]: generated,
      generated_note_metadata: {
        method,
        prediction_field: predictionField,
        token_budget: budget,
        source_tokens: tokenCount(source),
        reference_tokens: tokenCount(reference),
        generated_tokens: tokenCount(generated),
        row_index: index,
        caveat: "Deterministic extractive ACI note baseline. This is not an LLM-generated clinical note and not a clinical correctness score.",
      },
    };
  });

  return {
    schema_version: "aci-note-baseline-records-v1",
    generated_at: new Date().toISOString(),
    method,
    prediction_field: predictionField,
    summary: {
      records: records.length,
      mean_source_tokens: mean(records.map((row) => row.generated_note_metadata.source_tokens)),
      mean_reference_tokens: mean(records.map((row) => row.generated_note_metadata.reference_tokens)),
      mean_generated_tokens: mean(records.map((row) => row.generated_note_metadata.generated_tokens)),
    },
    records,
  };
}

function generateNote(source, reference, options) {
  const sourceText = String(source || "");
  const budget = Math.max(1, Number(options.tokenBudget) || tokenCount(reference) || 1);
  if (options.method === "source_full") return sourceText.trim();
  if (options.method === "lead_reference_length") return truncateTokens(sourceText, budget);
  if (options.method === "tail_reference_length") return tailTokens(sourceText, budget);
  if (options.method === "cue_sentence_extractive") return cueSentenceExtract(sourceText, budget);
  return "";
}

function cueSentenceExtract(source, budget) {
  const segments = splitSegments(source);
  if (!segments.length) return "";
  const scored = segments.map((text, index) => ({ text, index, score: cueScore(text) }));
  const selected = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => (right.score - left.score) || (left.index - right.index));
  const chosen = [];
  let used = 0;
  for (const item of selected) {
    const count = tokenCount(item.text);
    if (!count) continue;
    if (used && used + count > budget) continue;
    chosen.push(item);
    used += count;
    if (used >= budget * 0.95) break;
  }
  if (!chosen.length) return tailTokens(source, budget);
  chosen.sort((left, right) => left.index - right.index);
  return trimToBudget(chosen.map((item) => item.text).join(" "), budget);
}

function cueScore(text) {
  const normalized = normalize(text);
  let score = 0;
  for (const pattern of [
    /\bstart(?:ed)?\b/, /\bstop(?:ped)?\b/, /\bdiscontinue(?:d)?\b/, /\bcontinue(?:d)?\b/,
    /\bmg\b/, /\btablet\b/, /\bdose\b/, /\bmedication\b/, /\bprescrib(?:e|ed)\b/,
    /\bfollow\s?up\b/, /\bappointment\b/, /\breturn\b/, /\bcall\b/, /\bmonitor\b/,
    /\bcheck\b/, /\brepeat\b/, /\blab\b/, /\bcreatinine\b/, /\bpotassium\b/, /\bglucose\b/,
    /\bdiagnos(?:is|ed)\b/, /\bassessment\b/, /\bplan\b/, /\bdischarge\b/, /\badmit(?:ted)?\b/,
    /\bct\b/, /\bmri\b/, /\bxray\b/, /\bultrasound\b/, /\becho\b/, /\bprocedure\b/,
  ]) {
    if (pattern.test(normalized)) score += 1;
  }
  if (/^(doctor|clinician|provider|dr\.?)\b/i.test(String(text || "").trim())) score += 0.5;
  return score;
}

function splitSegments(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncateTokens(text, maxTokens) {
  return tokens(text).slice(0, maxTokens).join(" ");
}

function tailTokens(text, maxTokens) {
  const values = tokens(text);
  return values.slice(Math.max(0, values.length - maxTokens)).join(" ");
}

function trimToBudget(text, maxTokens) {
  const values = tokens(text);
  return values.length <= maxTokens ? String(text || "").trim() : values.slice(0, maxTokens).join(" ");
}

function tokenCount(text) { return tokens(text).length; }
function tokens(text) { return String(text || "").match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || []; }
function normalize(text) { return String(text || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim(); }

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

function mean(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.records;
  if (!input) {
    console.error("--input or --records is required");
    process.exit(1);
  }
  const report = generateAciNoteBaselineRows(readRows(input), {
    method: args.method,
    predictionField: args["prediction-field"],
    tokenBudget: args["token-budget"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

if (require.main === module) main();
module.exports = { BASELINE_METHODS, generateAciNoteBaselineRows, generateNote, cueSentenceExtract };
