#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readRows } = require("./adapt-aci-bench");

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-generation-score.json",
    split: "unknown",
    "prediction-field": "src",
    "bootstrap-repeats": "1000",
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

function scoreAciNoteGeneration(rows, options = {}) {
  const split = options.split || "unknown";
  const predictionField = options.predictionField || "src";
  const repeats = Number(options.bootstrapRepeats ?? 1000);
  const cases = [];
  const skipped = [];

  rows.forEach((row, index) => {
    const recordId = String(firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id", "file"]) || `${split}:${index + 1}`);
    const referenceText = firstValue(row, ["reference_text", "reference_note", "note", "clinical_note", "target", "tgt", "summary"]);
    const predictedText = firstValue(row, [predictionField]);
    if (!referenceText) {
      skipped.push({ record_id: recordId, issue: "missing_reference_text" });
      return;
    }
    if (!predictedText) {
      skipped.push({ record_id: recordId, issue: "missing_predicted_text" });
      return;
    }
    const prediction = String(predictedText);
    const reference = String(referenceText);
    cases.push({
      record_id: recordId,
      prediction_tokens: tokenize(prediction).length,
      reference_tokens: tokenize(reference).length,
      compression_ratio: ratio(tokenize(prediction).length, tokenize(reference).length),
      rouge1: rougeN(prediction, reference, 1),
      rouge2: rougeN(prediction, reference, 2),
      rougeL: rougeL(prediction, reference),
    });
  });

  return {
    generated_at: new Date().toISOString(),
    schema_version: "aci-note-generation-score-v1",
    split,
    prediction_field: predictionField,
    summary: summarize(cases, repeats),
    cases,
    skipped,
    interpretation: predictionField === "src"
      ? "ACI-shaped note-generation diagnostic using the source transcript as the prediction. This is a task-shape/transcript-overlap baseline, not a generated-note model score."
      : "ACI-shaped note-generation score over supplied generated-note predictions. ROUGE metrics are lexical overlap diagnostics and are not clinical correctness.",
  };
}

function summarize(cases, repeats) {
  const metrics = ["rouge1", "rouge2", "rougeL"];
  return {
    cases: cases.length,
    mean_reference_tokens: mean(cases.map((item) => item.reference_tokens)),
    mean_prediction_tokens: mean(cases.map((item) => item.prediction_tokens)),
    mean_compression_ratio: mean(cases.map((item) => item.compression_ratio)),
    metrics: Object.fromEntries(metrics.map((metric) => [metric, summarizeRouge(cases, metric, repeats)])),
  };
}

function summarizeRouge(cases, metric, repeats) {
  return {
    precision: mean(cases.map((item) => item[metric].precision)),
    recall: mean(cases.map((item) => item[metric].recall)),
    f1: mean(cases.map((item) => item[metric].f1)),
    f1_bootstrap_ci95: bootstrapMean(cases.map((item) => item[metric].f1), repeats),
  };
}

function rougeN(prediction, reference, n) {
  const pred = ngrams(tokenize(prediction), n);
  const ref = ngrams(tokenize(reference), n);
  return overlapScore(pred, ref);
}

function rougeL(prediction, reference) {
  const pred = tokenize(prediction);
  const ref = tokenize(reference);
  const lcs = lcsLength(pred, ref);
  const precision = ratio(lcs, pred.length);
  const recall = ratio(lcs, ref.length);
  return { precision, recall, f1: f1(precision, recall) };
}

function overlapScore(predictedItems, referenceItems) {
  const predicted = counts(predictedItems);
  const reference = counts(referenceItems);
  let overlap = 0;
  for (const [item, count] of Object.entries(predicted)) {
    overlap += Math.min(count, reference[item] || 0);
  }
  const precision = ratio(overlap, predictedItems.length);
  const recall = ratio(overlap, referenceItems.length);
  return { precision, recall, f1: f1(precision, recall) };
}

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || [];
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i += 1) out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

function lcsLength(a, b) {
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function counts(items) {
  const out = {};
  for (const item of items) out[item] = (out[item] || 0) + 1;
  return out;
}

function bootstrapMean(values, repeats) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  const aggregate = [];
  let state = 0x9e3779b9;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    let sum = 0;
    for (let i = 0; i < nums.length; i += 1) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      sum += nums[state % nums.length];
    }
    aggregate.push(sum / nums.length);
  }
  aggregate.sort((a, b) => a - b);
  return [aggregate[Math.floor(0.025 * (aggregate.length - 1))], aggregate[Math.floor(0.975 * (aggregate.length - 1))]];
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

function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function f1(precision, recall) { return precision && recall ? (2 * precision * recall) / (precision + recall) : 0; }
function mean(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error("--input is required");
    process.exit(1);
  }
  const report = scoreAciNoteGeneration(readRows(args.input), {
    split: args.split,
    predictionField: args["prediction-field"],
    bootstrapRepeats: args["bootstrap-repeats"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.cases) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { scoreAciNoteGeneration, rougeN, rougeL };
