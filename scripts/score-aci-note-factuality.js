#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readRows } = require("./adapt-aci-bench");

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-factuality-score.json",
    split: "unknown",
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

function scoreAciNoteFactuality(rows, options = {}) {
  const split = options.split || "unknown";
  const predictionField = options.predictionField || options["prediction-field"] || "generated_note";
  const cases = [];
  const skipped = [];

  rows.forEach((row, index) => {
    const recordId = String(firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id", "file"]) || `${split}:${index + 1}`);
    const source = firstValue(row, ["source_text", "src", "dialogue", "conversation", "transcript", "input", "text"]);
    const prediction = firstValue(row, [predictionField]);
    if (!source) {
      skipped.push({ record_id: recordId, issue: "missing_source_text" });
      return;
    }
    if (!prediction) {
      skipped.push({ record_id: recordId, issue: "missing_predicted_text" });
      return;
    }
    cases.push(scoreCase({ recordId, source, prediction }));
  });

  return {
    generated_at: new Date().toISOString(),
    schema_version: "aci-note-source-support-score-v1",
    split,
    prediction_field: predictionField,
    summary: summarize(cases),
    cases,
    skipped,
    interpretation: "Lexical source-support proxy for ACI note predictions. Token, bigram, and sentence extractiveness can catch unsupported generation, but they do not prove clinical factuality or adequate summarization.",
  };
}

function scoreCase({ recordId, source, prediction }) {
  const sourceTokenValues = tokens(source);
  const predictionTokenValues = tokens(prediction);
  const sourceTokenSet = new Set(sourceTokenValues);
  const predictionBigrams = ngrams(predictionTokenValues, 2);
  const sourceBigramSet = new Set(ngrams(sourceTokenValues, 2));
  const supportedTokens = predictionTokenValues.filter((token) => sourceTokenSet.has(token)).length;
  const supportedBigrams = predictionBigrams.filter((item) => sourceBigramSet.has(item)).length;
  const predictionSentences = splitSentences(prediction);
  const normalizedSource = normalizeForSubstring(source);
  const exactSupportedSentences = predictionSentences.filter((sentence) => normalizedSource.includes(normalizeForSubstring(sentence)));
  const unsupportedSentences = predictionSentences.filter((sentence) => !normalizedSource.includes(normalizeForSubstring(sentence)));

  return {
    record_id: recordId,
    prediction_tokens: predictionTokenValues.length,
    source_tokens: sourceTokenValues.length,
    source_token_support_rate: ratio(supportedTokens, predictionTokenValues.length),
    novel_token_rate: ratio(predictionTokenValues.length - supportedTokens, predictionTokenValues.length),
    source_bigram_support_rate: ratio(supportedBigrams, predictionBigrams.length),
    extractive_sentence_rate: ratio(exactSupportedSentences.length, predictionSentences.length),
    unsupported_sentence_count: unsupportedSentences.length,
    unsupported_sentence_examples: unsupportedSentences.slice(0, 5),
  };
}

function summarize(cases) {
  return {
    cases: cases.length,
    mean_prediction_tokens: mean(cases.map((item) => item.prediction_tokens)),
    mean_source_token_support_rate: mean(cases.map((item) => item.source_token_support_rate)),
    mean_novel_token_rate: mean(cases.map((item) => item.novel_token_rate)),
    mean_source_bigram_support_rate: mean(cases.map((item) => item.source_bigram_support_rate)),
    mean_extractive_sentence_rate: mean(cases.map((item) => item.extractive_sentence_rate)),
    cases_with_unsupported_sentences: cases.filter((item) => item.unsupported_sentence_count > 0).length,
  };
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ngrams(values, n) {
  const out = [];
  for (let i = 0; i <= values.length - n; i += 1) out.push(values.slice(i, i + n).join(" "));
  return out;
}

function tokens(text) { return String(text || "").toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || []; }
function normalizeForSubstring(text) { return tokens(text).join(" "); }
function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function mean(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.records;
  if (!input) {
    console.error("--input or --records is required");
    process.exit(1);
  }
  const report = scoreAciNoteFactuality(readRows(input), {
    split: args.split,
    predictionField: args["prediction-field"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.cases) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { scoreAciNoteFactuality, scoreCase };
