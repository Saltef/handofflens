#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { detectAssertionStatus } = require("./clinical-validation-signals");
const { parseBioScopeXml, collapseStatus, assertionInputForExample } = require("./evaluate-bioscope-assertions");

const LABELS = ["present", "absent", "possible"];

function parseArgs(argv) {
  const args = {
    out: "results/bioscope-conformal.json",
    corpus: "all",
    alpha: "0.10",
    "calibration-fraction": "0.50",
    seed: "handofflens-bioscope-conformal-v1",
    "target-mode": "sentence",
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

function evaluateBioScopeConformal(inputs, options = {}) {
  const alpha = numberOption(options.alpha, 0.10);
  const calibrationFraction = numberOption(options.calibrationFraction ?? options["calibration-fraction"], 0.50);
  const seed = String(options.seed || "handofflens-bioscope-conformal-v1");
  const targetMode = options.targetMode || options["target-mode"] || "sentence";
  const files = expandInputs(inputs);
  const examples = options.examples || files.flatMap((filePath) => parseBioScopeXml(fs.readFileSync(filePath, "utf8"), filePath));
  const filtered = (options.corpus && options.corpus !== "all")
    ? examples.filter((example) => example.corpus === options.corpus)
    : examples;
  const rows = filtered.map((example) => {
    const scores = assertionScores(example, { targetMode });
    const prediction = bestLabel(scores);
    return {
      ...example,
      scores,
      detected_status: prediction,
      nonconformity: 1 - scores[example.gold_status],
    };
  });
  const split = splitCalibrationTest(rows, { calibrationFraction, seed });
  const globalQ = conformalQuantile(split.calibration.map((row) => row.nonconformity), alpha);
  const labelConditionalQ = Object.fromEntries(LABELS.map((label) => [
    label,
    conformalQuantile(split.calibration.filter((row) => row.gold_status === label).map((row) => row.nonconformity), alpha),
  ]));
  const globalRows = applyPredictionSets(split.test, (label) => globalQ, "global");
  const labelConditionalRows = applyPredictionSets(split.test, (label) => labelConditionalQ[label], "label_conditional");

  return {
    generated_at: new Date().toISOString(),
    schema_version: "bioscope-conformal-assertion-v1",
    corpus: options.corpus || "all",
    target_mode: targetMode,
    uses_gold_scope_text: targetMode === "scope",
    files: files.map((filePath) => path.basename(filePath)),
    alpha,
    target_coverage: 1 - alpha,
    split: {
      strategy: split.strategy,
      seed,
      calibration_fraction: calibrationFraction,
      calibration_examples: split.calibration.length,
      test_examples: split.test.length,
      calibration_documents: uniqueCount(split.calibration.map(documentKey)),
      test_documents: uniqueCount(split.test.map(documentKey)),
    },
    primary_method: "label_conditional",
    conformal_quantiles: {
      global: finiteOrInfinity(globalQ),
      label_conditional: Object.fromEntries(LABELS.map((label) => [label, finiteOrInfinity(labelConditionalQ[label])])),
    },
    summary: summarizeConformal(labelConditionalRows),
    methods: {
      global: summarizeConformal(globalRows),
      label_conditional: summarizeConformal(labelConditionalRows),
    },
    baseline: summarizeHardLabels(split.test),
    by_corpus: Object.fromEntries([...new Set(split.test.map((item) => item.corpus))].sort().map((corpus) => [corpus, summarizeConformal(labelConditionalRows.filter((item) => item.corpus === corpus))])),
    interpretation: targetMode === "scope"
      ? "Scope-assisted split-conformal assertion prediction sets over collapsed BioScope labels. The detector receives BioScope xcope text, so this is a diagnostic for calibrated abstention behavior, not the primary sentence-only benchmark and not a standard BioScope scope-boundary result."
      : "Sentence-only split-conformal assertion prediction sets over collapsed BioScope labels. This controls marginal prediction-set coverage under exchangeability of the calibration and test examples. Singleton sets are automatically accepted; multi-label sets are abstentions/escalations. This is not a clinical safety guarantee.",
    score_model: "Transparent lexical assertion score derived from the same cue families as the hard assertion detector, with lower confidence for conflicting or weak cue evidence.",
  };
}

function applyPredictionSets(rows, quantileForLabel, method) {
  return rows.map((row) => {
    const predictionSet = LABELS.filter((label) => (1 - row.scores[label]) <= quantileForLabel(label));
    return {
      ...row,
      conformal_method: method,
      prediction_set: predictionSet,
      covered: predictionSet.includes(row.gold_status),
      singleton: predictionSet.length === 1,
      accepted: predictionSet.length === 1,
    };
  });
}

function assertionScores(example, options = {}) {
  const targetMode = options.targetMode || "sentence";
  const assertionInput = assertionInputForExample(example, targetMode);
  const detectedRaw = detectAssertionStatus({
    sourceText: assertionInput.sourceText,
    quote: assertionInput.quote,
    label: assertionInput.label,
    windowChars: 220,
  }).status;
  const detected = collapseStatus(detectedRaw);
  const text = normalize(targetMode === "scope" ? `${example.scope_text || ""}` : `${example.text || ""}`);
  const neg = cueStrength(text, [
    /\bno\b/g, /\bnot\b/g, /\bwithout\b/g, /\bdenies?\b/g, /\bdenied\b/g,
    /\bnegative for\b/g, /\bno evidence of\b/g, /\bruled out\b/g, /\babsence of\b/g,
  ]);
  const spec = cueStrength(text, [
    /\bpossible\b/g, /\bpossibly\b/g, /\bprobable\b/g, /\bprobably\b/g,
    /\bsuspected\b/g, /\bconcern for\b/g, /\bquestion of\b/g, /\bmay\b/g,
    /\bmight\b/g, /\bcould\b/g, /\bcannot exclude\b/g, /\brule out\b/g,
    /\bsuggests?\b/g, /\bindicates?\b/g, /\bappears?\b/g, /\blikely\b/g,
    /\bpossibility\b/g, /\bpotentially\b/g, /\bwhether\b/g,
  ]);
  const conflict = neg > 0 && spec > 0;
  const base = { present: 0.34, absent: 0.33, possible: 0.33 };
  if (detected === "present") {
    base.present = 0.64;
    base.absent = Math.max(0.18, 0.26 + neg * 0.08);
    base.possible = Math.max(0.18, 0.26 + spec * 0.08);
  } else if (detected === "absent") {
    base.absent = 0.72 + Math.min(0.12, neg * 0.04);
    base.possible = conflict ? 0.48 : 0.20 + spec * 0.04;
    base.present = conflict ? 0.30 : 0.18;
  } else {
    base.possible = 0.72 + Math.min(0.12, spec * 0.04);
    base.absent = conflict ? 0.48 : 0.18 + neg * 0.04;
    base.present = conflict ? 0.30 : 0.20;
  }
  return normalizeScores(base);
}

function summarizeConformal(rows) {
  const covered = rows.filter((row) => row.covered).length;
  const singleton = rows.filter((row) => row.singleton).length;
  const acceptedCorrect = rows.filter((row) => row.singleton && row.detected_status === row.gold_status).length;
  return {
    examples: rows.length,
    empirical_coverage: ratio(covered, rows.length),
    empirical_coverage_ci95: wilson(covered, rows.length),
    mean_prediction_set_size: mean(rows.map((row) => row.prediction_set.length)),
    singleton_acceptance_rate: ratio(singleton, rows.length),
    abstention_rate: ratio(rows.length - singleton, rows.length),
    accepted_accuracy: ratio(acceptedCorrect, singleton),
    class_conditional_coverage: Object.fromEntries(LABELS.map((label) => {
      const classRows = rows.filter((row) => row.gold_status === label);
      return [label, ratio(classRows.filter((row) => row.covered).length, classRows.length)];
    })),
    singleton_counts_by_gold: Object.fromEntries(LABELS.map((label) => [label, rows.filter((row) => row.gold_status === label && row.singleton).length])),
  };
}

function summarizeHardLabels(rows) {
  const correct = rows.filter((row) => row.detected_status === row.gold_status).length;
  return {
    examples: rows.length,
    hard_label_accuracy: ratio(correct, rows.length),
    hard_label_macro_f1: LABELS.reduce((sum, label) => sum + f1ForLabel(rows, label), 0) / LABELS.length,
    hard_label_per_class_f1: Object.fromEntries(LABELS.map((label) => [label, f1ForLabel(rows, label)])),
  };
}

function splitCalibrationTest(rows, options) {
  const docs = [...new Set(rows.map(documentKey))];
  if (docs.length >= 2) {
    const sortedDocs = docs.sort((a, b) => hashFloat(`${options.seed}:${a}`) - hashFloat(`${options.seed}:${b}`));
    const calibrationDocCount = Math.min(sortedDocs.length - 1, Math.max(1, Math.round(sortedDocs.length * options.calibrationFraction)));
    const calibrationDocs = new Set(sortedDocs.slice(0, calibrationDocCount));
    return {
      strategy: "document_hash_split",
      calibration: rows.filter((row) => calibrationDocs.has(documentKey(row))),
      test: rows.filter((row) => !calibrationDocs.has(documentKey(row))),
    };
  }
  const sortedRows = [...rows].sort((a, b) => hashFloat(`${options.seed}:${a.id}`) - hashFloat(`${options.seed}:${b.id}`));
  const calibrationCount = Math.min(sortedRows.length - 1, Math.max(1, Math.round(sortedRows.length * options.calibrationFraction)));
  const calibrationIds = new Set(sortedRows.slice(0, calibrationCount).map((row) => row.id));
  return {
    strategy: "row_hash_split_single_document_fallback",
    calibration: rows.filter((row) => calibrationIds.has(row.id)),
    test: rows.filter((row) => !calibrationIds.has(row.id)),
  };
}

function expandInputs(inputs) {
  const out = [];
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(input)) {
        const next = path.join(input, child);
        if (fs.statSync(next).isDirectory()) out.push(...expandInputs([next]));
        else if (next.toLowerCase().endsWith(".xml")) out.push(next);
      }
    } else if (input.toLowerCase().endsWith(".xml")) out.push(input);
  }
  return out.sort();
}

function conformalQuantile(scores, alpha) {
  if (!scores.length) return Infinity;
  const sorted = [...scores].sort((a, b) => a - b);
  const rank = Math.ceil((scores.length + 1) * (1 - alpha));
  if (rank > sorted.length) return Infinity;
  return sorted[rank - 1];
}

function finiteOrInfinity(value) {
  return Number.isFinite(value) ? value : "Infinity";
}

function bestLabel(scores) {
  return LABELS.reduce((best, label) => scores[label] > scores[best] ? label : best, LABELS[0]);
}

function cueStrength(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + [...text.matchAll(pattern)].length, 0);
}

function normalizeScores(scores) {
  const clipped = Object.fromEntries(LABELS.map((label) => [label, Math.max(0.01, Math.min(0.98, scores[label]))]));
  const total = LABELS.reduce((sum, label) => sum + clipped[label], 0);
  return Object.fromEntries(LABELS.map((label) => [label, clipped[label] / total]));
}

function f1ForLabel(rows, label) {
  const tp = rows.filter((row) => row.gold_status === label && row.detected_status === label).length;
  const fp = rows.filter((row) => row.gold_status !== label && row.detected_status === label).length;
  const fn = rows.filter((row) => row.gold_status === label && row.detected_status !== label).length;
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return precision && recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function documentKey(row) {
  return `${row.source_file || "unknown"}:${row.document_id || row.id}`;
}

function uniqueCount(values) {
  return new Set(values).size;
}

function hashFloat(value) {
  const hex = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function wilson(x, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = x / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = String(args.input || "").split(";").filter(Boolean);
  if (!inputs.length) {
    console.error("--input is required; use semicolon-separated XML paths or directories");
    process.exit(1);
  }
  const report = evaluateBioScopeConformal(inputs, {
    corpus: args.corpus,
    alpha: args.alpha,
    calibrationFraction: args["calibration-fraction"],
    seed: args.seed,
    targetMode: args["target-mode"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ split: report.split, primary_method: report.primary_method, summary: report.summary, methods: report.methods, baseline: report.baseline }, null, 2));
}

if (require.main === module) main();
module.exports = { evaluateBioScopeConformal, assertionScores, conformalQuantile };
