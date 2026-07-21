#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const goldPath = required(args.gold, "--gold is required");
  const predictionsPath = required(args.predictions, "--predictions is required");
  const outPath = args.out || "results/adjudicated-gold-analysis.json";
  const minScore = Number(args["min-score"] || 0.72);
  const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));
  const predictions = JSON.parse(fs.readFileSync(predictionsPath, "utf8"));
  const report = analyzeAdjudicatedGold({ gold, predictions, minScore });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeAdjudicatedGold({ gold, predictions, minScore = 0.72 }) {
  const goldCases = normalizeGoldCases(gold);
  const predictionCases = normalizePredictionCases(predictions);
  const caseReports = [];
  for (const [caseId, goldItems] of Object.entries(goldCases)) {
    const predictedItems = predictionCases[caseId] || [];
    caseReports.push(matchCase({ caseId, goldItems, predictedItems, minScore }));
  }
  const summary = summarize(caseReports);
  return {
    generated_at: new Date().toISOString(),
    schema_version: "adjudicated-gold-analysis-v1",
    min_score: minScore,
    summary,
    by_domain: summarizeByDomain(caseReports),
    cases: caseReports,
    interpretation: "Item-level source-fidelity proxy against an adjudicated gold item list. This estimates extraction precision/recall for explicit adjudicated targets only; it does not establish clinical safety, appropriateness, or external validity.",
  };
}

function normalizeGoldCases(payload) {
  const cases = {};
  for (const item of payload.cases || []) {
    const caseId = String(item.case_id || item.id || "");
    if (!caseId) continue;
    cases[caseId] = (item.gold_items || item.expected_items || []).map((entry, index) => normalizeItem(entry, caseId, `G${index + 1}`, "gold"));
  }
  return cases;
}

function normalizePredictionCases(payload) {
  const cases = {};
  if (Array.isArray(payload.records)) {
    for (const record of payload.records) {
      const caseId = String(record.case_id || "");
      if (!caseId) continue;
      cases[caseId] = flattenExtraction(record.extraction || {}).map((entry, index) => normalizeItem(entry, caseId, `P${index + 1}`, "prediction"));
    }
    return cases;
  }
  for (const item of payload.cases || []) {
    const caseId = String(item.case_id || item.id || "");
    if (!caseId) continue;
    const direct = item.predicted_items || item.predictions;
    cases[caseId] = Array.isArray(direct)
      ? direct.map((entry, index) => normalizeItem(entry, caseId, `P${index + 1}`, "prediction"))
      : flattenExtraction(item.extraction || {}).map((entry, index) => normalizeItem(entry, caseId, `P${index + 1}`, "prediction"));
  }
  return cases;
}

function flattenExtraction(extraction) {
  const items = [];
  const meds = extraction.medication_changes || {};
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) {
    for (const item of array(meds[key])) items.push({ ...item, domain: `medication_changes.${key}` });
  }
  const diagnoses = extraction.diagnosis_changes || {};
  for (const item of array(diagnoses.discharge)) items.push({ ...item, domain: "diagnosis_changes.discharge" });
  for (const item of array(diagnoses.new_or_changed)) items.push({ ...item, domain: "diagnosis_changes.new_or_changed" });
  for (const domain of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) {
    for (const item of array(extraction[domain])) items.push({ ...item, domain });
  }
  return items;
}

function matchCase({ caseId, goldItems, predictedItems, minScore }) {
  const matches = [];
  const unmatchedGold = new Set(goldItems.map((item) => item.id));
  const unmatchedPredictions = new Set(predictedItems.map((item) => item.id));
  const candidates = [];
  for (const prediction of predictedItems) {
    for (const gold of goldItems) {
      if (!domainsCompatible(prediction.domain, gold.domain)) continue;
      const score = itemSimilarity(prediction, gold);
      if (score >= minScore) candidates.push({ prediction, gold, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.prediction.id.localeCompare(b.prediction.id));
  for (const candidate of candidates) {
    if (!unmatchedPredictions.has(candidate.prediction.id) || !unmatchedGold.has(candidate.gold.id)) continue;
    matches.push({
      prediction_id: candidate.prediction.id,
      gold_id: candidate.gold.id,
      domain: candidate.gold.domain,
      score: Number(candidate.score.toFixed(3)),
      label_pair: { predicted: candidate.prediction.label, gold: candidate.gold.label },
    });
    unmatchedPredictions.delete(candidate.prediction.id);
    unmatchedGold.delete(candidate.gold.id);
  }
  const falsePositives = predictedItems.filter((item) => unmatchedPredictions.has(item.id));
  const falseNegatives = goldItems.filter((item) => unmatchedGold.has(item.id));
  return {
    case_id: caseId,
    gold_items: goldItems.length,
    predicted_items: predictedItems.length,
    true_positives: matches.length,
    false_positives: falsePositives.length,
    false_negatives: falseNegatives.length,
    precision: ratio(matches.length, matches.length + falsePositives.length),
    recall: ratio(matches.length, matches.length + falseNegatives.length),
    f1: f1(matches.length, falsePositives.length, falseNegatives.length),
    matches,
    false_positive_items: falsePositives,
    false_negative_items: falseNegatives,
  };
}

function summarize(caseReports) {
  const totals = caseReports.reduce((acc, item) => {
    acc.cases += 1;
    acc.gold_items += item.gold_items;
    acc.predicted_items += item.predicted_items;
    acc.true_positives += item.true_positives;
    acc.false_positives += item.false_positives;
    acc.false_negatives += item.false_negatives;
    return acc;
  }, { cases: 0, gold_items: 0, predicted_items: 0, true_positives: 0, false_positives: 0, false_negatives: 0 });
  return {
    ...totals,
    precision: ratio(totals.true_positives, totals.true_positives + totals.false_positives),
    recall: ratio(totals.true_positives, totals.true_positives + totals.false_negatives),
    f1: f1(totals.true_positives, totals.false_positives, totals.false_negatives),
    precision_ci95: wilson(totals.true_positives, totals.true_positives + totals.false_positives),
    recall_ci95: wilson(totals.true_positives, totals.true_positives + totals.false_negatives),
  };
}

function summarizeByDomain(caseReports) {
  const buckets = {};
  for (const report of caseReports) {
    for (const match of report.matches) {
      buckets[match.domain] ||= emptyBucket();
      buckets[match.domain].tp += 1;
    }
    for (const item of report.false_positive_items) {
      const domain = broadDomain(item.domain) || item.domain;
      buckets[domain] ||= emptyBucket();
      buckets[domain].fp += 1;
    }
    for (const item of report.false_negative_items) {
      const domain = broadDomain(item.domain) || item.domain;
      buckets[domain] ||= emptyBucket();
      buckets[domain].fn += 1;
    }
  }
  return Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([domain, bucket]) => [domain, {
    true_positives: bucket.tp,
    false_positives: bucket.fp,
    false_negatives: bucket.fn,
    precision: ratio(bucket.tp, bucket.tp + bucket.fp),
    recall: ratio(bucket.tp, bucket.tp + bucket.fn),
    f1: f1(bucket.tp, bucket.fp, bucket.fn),
  }]));
}

function normalizeItem(entry, caseId, fallbackId, source) {
  return {
    id: String(entry.item_id || entry.gold_id || entry.prediction_id || entry.claim_id || `${caseId}:${source}:${fallbackId}`),
    domain: canonicalDomain(entry.domain || entry.category || entry.path || ""),
    label: String(entry.label || entry.text || entry.description || ""),
    source_quote: String(entry.source_quote || entry.quote || ""),
    assertion_status: String(entry.assertion_status || "present"),
  };
}

function itemSimilarity(left, right) {
  const labelScore = dice(tokens(left.label), tokens(right.label));
  const quoteScore = dice(tokens(left.source_quote), tokens(right.source_quote));
  const assertionPenalty = left.assertion_status && right.assertion_status && left.assertion_status !== right.assertion_status ? 0.12 : 0;
  return Math.max(labelScore, (labelScore * 0.7) + (quoteScore * 0.3)) - assertionPenalty;
}

function domainsCompatible(left, right) {
  const a = broadDomain(left);
  const b = broadDomain(right);
  return a && b && a === b;
}

function canonicalDomain(value) {
  return String(value || "").trim().toLowerCase();
}

function broadDomain(value) {
  const text = canonicalDomain(value);
  if (text.includes("medication")) return "medication";
  if (text.includes("diagnosis")) return "diagnosis";
  if (text.includes("procedure") || text.includes("test")) return "procedure_or_test";
  if (text.includes("lab")) return "lab";
  if (text.includes("follow")) return "follow_up";
  if (text.includes("safety")) return "safety";
  if (text.includes("uncertain")) return "uncertain";
  return text || null;
}

function tokens(value) {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "patient", "discharge", "continued", "started", "changed", "stopped"]);
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function dice(left, right) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function emptyBucket() {
  return { tp: 0, fp: 0, fn: 0 };
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function f1(tp, fp, fn) {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return precision && recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function wilson(x, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = x / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt((p * (1 - p) / n) + (z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
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

module.exports = { analyzeAdjudicatedGold, flattenExtraction, itemSimilarity };
