#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { out: "results/benchmark-score.json", "relaxed-threshold": "0.67", "bootstrap-repeats": "1000" };
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

function scoreBenchmarkRecords({ records, predictions, relaxedThreshold = 0.67, bootstrapRepeats = 1000 }) {
  const goldById = normalizeRecords(records);
  const predictionById = normalizePredictions(predictions);
  const caseReports = [];

  for (const [recordId, goldItems] of Object.entries(goldById)) {
    const predictedItems = predictionById[recordId] || [];
    caseReports.push({
      record_id: recordId,
      gold_items: goldItems.length,
      predicted_items: predictedItems.length,
      exact: matchCase(goldItems, predictedItems, exactScore, 1),
      relaxed: matchCase(goldItems, predictedItems, relaxedScore, relaxedThreshold),
    });
  }

  const scoredCases = caseReports.filter((report) => report.gold_items > 0);
  return {
    generated_at: new Date().toISOString(),
    schema_version: "handofflens-benchmark-score-v1",
    matching: {
      exact: "domain-compatible and exact span when spans exist, otherwise exact normalized label",
      relaxed: `domain-compatible and token Dice >= ${relaxedThreshold}`,
      assignment: "maximum-weight one-to-one assignment per case and metric",
    },
    summary: summarize(scoredCases, bootstrapRepeats),
    by_domain: summarizeDomains(scoredCases),
    cases: caseReports,
    interpretation: scoredCases.length
      ? "Item-level benchmark scoring over supplied gold_items. These numbers are only benchmark-comparable when the adapter and gold labels are dataset-authorized and documented."
      : "No scored cases: records contain no gold_items. ACI-style reference notes alone are not item-level extraction gold.",
  };
}

function normalizeRecords(payload) {
  const records = Array.isArray(payload) ? payload : payload.records || payload.cases || [];
  const out = {};
  for (const record of records) {
    const id = String(record.record_id || record.case_id || record.id || "");
    if (!id) continue;
    out[id] = normalizeItems(record.gold_items || record.expected_items || [], id, "G");
  }
  return out;
}

function normalizePredictions(payload) {
  const records = Array.isArray(payload) ? payload : payload.records || payload.cases || [];
  const out = {};
  for (const record of records) {
    const id = String(record.record_id || record.case_id || record.id || "");
    if (!id) continue;
    const direct = record.predicted_items || record.predictions;
    out[id] = normalizeItems(Array.isArray(direct) ? direct : flattenExtraction(record.extraction || {}), id, "P");
  }
  return out;
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

function normalizeItems(items, recordId, prefix) {
  return array(items).map((item, index) => ({
    item_id: String(item.item_id || item.prediction_id || item.gold_id || `${recordId}:${prefix}${index + 1}`),
    domain: canonicalDomain(item.domain || item.category || item.path || ""),
    label: normalizeText(item.label || item.text || item.description || ""),
    raw_label: String(item.label || item.text || item.description || ""),
    source_quote: normalizeText(item.source_quote || item.quote || ""),
    assertion_status: String(item.assertion_status || "unknown").toLowerCase(),
    span: normalizeSpan(item.span),
  })).filter((item) => item.label || item.source_quote || item.span);
}

function matchCase(goldItems, predictedItems, scorer, threshold) {
  if (!goldItems.length) return emptyMatchReport();
  const candidates = [];
  for (let p = 0; p < predictedItems.length; p += 1) {
    for (let g = 0; g < goldItems.length; g += 1) {
      if (!domainsCompatible(predictedItems[p].domain, goldItems[g].domain)) continue;
      const score = scorer(predictedItems[p], goldItems[g]);
      if (score >= threshold) candidates.push({ prediction: p, gold: g, score });
    }
  }
  const matches = optimalAssignment(candidates, predictedItems.length, goldItems.length);
  const matchedPredictions = new Set(matches.map((match) => match.prediction));
  const matchedGold = new Set(matches.map((match) => match.gold));
  const falsePositiveItems = predictedItems.filter((_, index) => !matchedPredictions.has(index));
  const falseNegativeItems = goldItems.filter((_, index) => !matchedGold.has(index));
  return {
    true_positives: matches.length,
    false_positives: falsePositiveItems.length,
    false_negatives: falseNegativeItems.length,
    precision: ratio(matches.length, matches.length + falsePositiveItems.length),
    recall: ratio(matches.length, matches.length + falseNegativeItems.length),
    f1: f1(matches.length, falsePositiveItems.length, falseNegativeItems.length),
    matches: matches.map((match) => ({
      prediction_id: predictedItems[match.prediction].item_id,
      gold_id: goldItems[match.gold].item_id,
      domain: broadDomain(goldItems[match.gold].domain),
      score: Number(match.score.toFixed(3)),
    })),
    false_positive_items: falsePositiveItems,
    false_negative_items: falseNegativeItems,
  };
}

function optimalAssignment(candidates, predictionCount, goldCount) {
  if (!candidates.length) return [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (predictionCount > 20 || goldCount > 20) return greedyAssignment(sorted);
  const byPrediction = new Map();
  for (const candidate of sorted) {
    if (!byPrediction.has(candidate.prediction)) byPrediction.set(candidate.prediction, []);
    byPrediction.get(candidate.prediction).push(candidate);
  }
  const predictionOrder = [...byPrediction.keys()].sort((a, b) => a - b);
  const memo = new Map();
  function search(pos, usedGoldMask) {
    const key = `${pos}|${usedGoldMask}`;
    if (memo.has(key)) return memo.get(key);
    if (pos >= predictionOrder.length) return { score: 0, matches: [] };
    const prediction = predictionOrder[pos];
    let best = search(pos + 1, usedGoldMask);
    for (const candidate of byPrediction.get(prediction) || []) {
      const bit = 1 << candidate.gold;
      if (usedGoldMask & bit) continue;
      const rest = search(pos + 1, usedGoldMask | bit);
      const next = { score: candidate.score + rest.score, matches: [candidate, ...rest.matches] };
      if (next.matches.length > best.matches.length || (next.matches.length === best.matches.length && next.score > best.score)) best = next;
    }
    memo.set(key, best);
    return best;
  }
  return search(0, 0).matches.sort((a, b) => a.prediction - b.prediction || a.gold - b.gold);
}

function greedyAssignment(candidates) {
  const usedPredictions = new Set();
  const usedGold = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (usedPredictions.has(candidate.prediction) || usedGold.has(candidate.gold)) continue;
    usedPredictions.add(candidate.prediction);
    usedGold.add(candidate.gold);
    matches.push(candidate);
  }
  return matches.sort((a, b) => a.prediction - b.prediction || a.gold - b.gold);
}

function exactScore(prediction, gold) {
  if (prediction.span && gold.span) return prediction.span.start === gold.span.start && prediction.span.end === gold.span.end ? 1 : 0;
  return prediction.label && gold.label && prediction.label === gold.label ? 1 : 0;
}

function relaxedScore(prediction, gold) {
  const labelScore = dice(tokens(prediction.label), tokens(gold.label));
  const quoteScore = dice(tokens(prediction.source_quote), tokens(gold.source_quote));
  const assertionPenalty = prediction.assertion_status !== "unknown" && gold.assertion_status !== "unknown" && prediction.assertion_status !== gold.assertion_status ? 0.12 : 0;
  const quoteAnchoredScore = quoteScore >= 0.95 && prediction.source_quote && gold.source_quote ? quoteScore : 0;
  return Math.max(labelScore, quoteAnchoredScore, (labelScore * 0.7) + (quoteScore * 0.3)) - assertionPenalty;
}

function summarize(caseReports, bootstrapRepeats) {
  return {
    cases: caseReports.length,
    exact: aggregate(caseReports.map((report) => report.exact), caseReports, bootstrapRepeats),
    relaxed: aggregate(caseReports.map((report) => report.relaxed), caseReports, bootstrapRepeats),
  };
}

function aggregate(metricReports, caseReports, bootstrapRepeats) {
  const total = metricReports.reduce((acc, report) => {
    acc.tp += report.true_positives;
    acc.fp += report.false_positives;
    acc.fn += report.false_negatives;
    return acc;
  }, { tp: 0, fp: 0, fn: 0 });
  return {
    true_positives: total.tp,
    false_positives: total.fp,
    false_negatives: total.fn,
    precision: ratio(total.tp, total.tp + total.fp),
    recall: ratio(total.tp, total.tp + total.fn),
    f1: f1(total.tp, total.fp, total.fn),
    precision_ci95: wilson(total.tp, total.tp + total.fp),
    recall_ci95: wilson(total.tp, total.tp + total.fn),
    f1_bootstrap_ci95: bootstrapF1(caseReports, metricReports, bootstrapRepeats),
  };
}

function summarizeDomains(caseReports) {
  const buckets = {};
  for (const report of caseReports) {
    addDomainCounts(buckets, report.exact, "exact");
    addDomainCounts(buckets, report.relaxed, "relaxed");
  }
  return Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([domain, metrics]) => [domain, {
    exact: aggregateCounts(metrics.exact),
    relaxed: aggregateCounts(metrics.relaxed),
  }]));
}

function addDomainCounts(buckets, metricReport, metricName) {
  for (const match of metricReport.matches) {
    buckets[match.domain] ||= { exact: { tp: 0, fp: 0, fn: 0 }, relaxed: { tp: 0, fp: 0, fn: 0 } };
    buckets[match.domain][metricName].tp += 1;
  }
  for (const item of metricReport.false_positive_items) {
    const domain = broadDomain(item.domain);
    buckets[domain] ||= { exact: { tp: 0, fp: 0, fn: 0 }, relaxed: { tp: 0, fp: 0, fn: 0 } };
    buckets[domain][metricName].fp += 1;
  }
  for (const item of metricReport.false_negative_items) {
    const domain = broadDomain(item.domain);
    buckets[domain] ||= { exact: { tp: 0, fp: 0, fn: 0 }, relaxed: { tp: 0, fp: 0, fn: 0 } };
    buckets[domain][metricName].fn += 1;
  }
}

function aggregateCounts(counts) {
  return {
    true_positives: counts.tp,
    false_positives: counts.fp,
    false_negatives: counts.fn,
    precision: ratio(counts.tp, counts.tp + counts.fp),
    recall: ratio(counts.tp, counts.tp + counts.fn),
    f1: f1(counts.tp, counts.fp, counts.fn),
  };
}

function bootstrapF1(caseReports, metricReports, repeats) {
  if (!caseReports.length || repeats <= 0) return null;
  let state = 20260721;
  const values = [];
  for (let i = 0; i < repeats; i += 1) {
    let tp = 0, fp = 0, fn = 0;
    for (let j = 0; j < caseReports.length; j += 1) {
      state = (1664525 * state + 1013904223) >>> 0;
      const index = Math.floor((state / 0x100000000) * metricReports.length);
      tp += metricReports[index].true_positives;
      fp += metricReports[index].false_positives;
      fn += metricReports[index].false_negatives;
    }
    values.push(f1(tp, fp, fn));
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(0.025 * (values.length - 1))], values[Math.floor(0.975 * (values.length - 1))]];
}

function emptyMatchReport() {
  return { true_positives: 0, false_positives: 0, false_negatives: 0, precision: null, recall: null, f1: 0, matches: [], false_positive_items: [], false_negative_items: [] };
}

function normalizeSpan(span) {
  if (!span || typeof span !== "object") return null;
  const start = Number(span.start);
  const end = Number(span.end);
  return Number.isInteger(start) && Number.isInteger(end) && end >= start ? { start, end } : null;
}

function domainsCompatible(left, right) {
  return broadDomain(left) === broadDomain(right);
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
  return text || "unknown";
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(value) {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "patient", "discharge", "continued", "started", "changed", "stopped"]);
  return normalizeText(value).split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token));
}

function dice(left, right) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.records || !args.predictions) {
    console.error("--records and --predictions are required");
    process.exit(1);
  }
  const report = scoreBenchmarkRecords({
    records: readJson(args.records),
    predictions: readJson(args.predictions),
    relaxedThreshold: Number(args["relaxed-threshold"]),
    bootstrapRepeats: Number(args["bootstrap-repeats"]),
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.cases) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { scoreBenchmarkRecords, exactScore, relaxedScore, optimalAssignment };