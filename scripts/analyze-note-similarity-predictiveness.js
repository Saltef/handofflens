#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const routingPaths = (args.routing || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const outPath = args.out || path.join("results", "note-similarity-predictiveness.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const maxTerms = Number(args["max-terms"] || 5000);
const neighborCounts = String(args.k || "3,5,10,20")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isInteger(item) && item > 0);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "was", "were", "are", "his", "her", "had",
  "has", "have", "from", "not", "but", "she", "you", "all", "can", "out", "one", "two",
  "patient", "patients", "date", "name", "hospital", "last", "first", "discharge",
  "admission", "service", "history", "past", "medical", "present", "illness"
]);

if (!routingPaths.length) throw new Error("--routing is required");
if (!neighborCounts.length) throw new Error("--k must include at least one positive integer");

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const reports = routingPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
const analyses = reports.flatMap((report) => report.analyses || []);
const vectorsByCaseId = buildTfIdfVectors(cases, maxTerms);
const byModel = groupBy(analyses, (item) => item.model || "unknown");

const output = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  routing_paths: routingPaths,
  method: {
    name: "leave-one-out TF-IDF note-neighbor retrieval",
    max_terms: maxTerms,
    neighbor_counts: neighborCounts,
    caution: "This is a dependency-free lexical retrieval baseline, not a clinical embedding model. It tests whether similar notes have similar workflow outcomes."
  },
  models: {}
};

for (const [model, items] of Object.entries(byModel)) {
  const rows = items
    .map((item) => ({ ...item, case: casesById.get(item.case_id), vector: vectorsByCaseId.get(item.case_id) }))
    .filter((item) => item.case && item.vector);

  const targets = {
    technical_failure: (item) => item.issues.some((issue) => issue.type === "technical_failure") || item.allocation === "retry_or_alternate_model",
    clinician_review: (item) => item.allocation === "clinician_review",
    human_or_medication_review: (item) => ["human_review", "medication_reconciliation_review"].includes(item.allocation),
    any_escalation_except_spot_check: (item) => !["accept_as_draft", "clinician_spot_check"].includes(item.allocation)
  };

  output.models[model] = {
    cases: rows.length,
    target_event_rates: Object.fromEntries(Object.entries(targets).map(([name, fn]) => [name, rate(rows, fn)])),
    targets: Object.fromEntries(Object.entries(targets).map(([targetName, targetFn]) => [
      targetName,
      analyzeTarget(rows, targetFn, neighborCounts)
    ]))
  };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(mdOutPath, renderMarkdown(output));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdOutPath}`);

function buildTfIdfVectors(cases, maxTerms) {
  const docs = cases.map((item) => ({
    case_id: item.case_id,
    tokens: tokenize(`${item.admission_diagnosis || ""}\n${item.discharge_summary || ""}`)
  }));
  const docFreq = new Map();
  for (const doc of docs) {
    for (const token of new Set(doc.tokens)) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }
  const n = docs.length;
  const vocab = [...docFreq.entries()]
    .filter(([, df]) => df >= 3 && df <= n * 0.85)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([token]) => token);
  const vocabSet = new Set(vocab);
  const idf = new Map(vocab.map((token) => [token, Math.log((1 + n) / (1 + docFreq.get(token))) + 1]));
  const vectors = new Map();

  for (const doc of docs) {
    const counts = new Map();
    for (const token of doc.tokens) {
      if (!vocabSet.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    const vector = [];
    let norm = 0;
    for (const [token, count] of counts.entries()) {
      const value = (1 + Math.log(count)) * idf.get(token);
      vector.push([token, value]);
      norm += value * value;
    }
    vectors.set(doc.case_id, { values: vector, norm: Math.sqrt(norm) || 1 });
  }
  return vectors;
}

function tokenize(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/\[\*\*.*?\*\*\]/g, " ")
    .replace(/[^a-z0-9%./+-]+/g, " ");
  const words = normalized
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  const bigrams = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    bigrams.push(`${words[index]}_${words[index + 1]}`);
  }
  return [...words, ...bigrams];
}

function analyzeTarget(rows, targetFn, neighborCounts) {
  const predictionsByK = Object.fromEntries(neighborCounts.map((k) => [String(k), []]));
  const neighborExamples = [];

  for (const row of rows) {
    const neighbors = rows
      .filter((candidate) => candidate.case_id !== row.case_id)
      .map((candidate) => ({
        case_id: candidate.case_id,
        similarity: cosine(row.vector, candidate.vector),
        event: targetFn(candidate),
        allocation: candidate.allocation
      }))
      .sort((a, b) => b.similarity - a.similarity);

    for (const k of neighborCounts) {
      const selected = neighbors.slice(0, k);
      const score = weightedNeighborRate(selected);
      predictionsByK[String(k)].push({
        case_id: row.case_id,
        score,
        event: targetFn(row),
        allocation: row.allocation,
        nearest_neighbors: selected.slice(0, 5)
      });
    }
    if (neighborExamples.length < 8) {
      neighborExamples.push({
        case_id: row.case_id,
        allocation: row.allocation,
        event: targetFn(row),
        nearest_neighbors: neighbors.slice(0, 5)
      });
    }
  }

  const kSummaries = Object.fromEntries(Object.entries(predictionsByK).map(([k, predictions]) => {
    const sorted = [...predictions].sort((a, b) => b.score - a.score);
    return [k, {
      auc: auc(predictions.map((item) => ({ value: item.score, event: item.event }))),
      mean_score_event: mean(predictions.filter((item) => item.event).map((item) => item.score)),
      mean_score_no_event: mean(predictions.filter((item) => !item.event).map((item) => item.score)),
      top_decile_event_rate: eventRate(sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.10)))),
      bottom_decile_event_rate: eventRate(sorted.slice(-Math.max(1, Math.ceil(sorted.length * 0.10))))
    }];
  }));

  return {
    events: rows.filter(targetFn).length,
    event_rate: rate(rows, targetFn),
    by_k: kSummaries,
    examples: neighborExamples
  };
}

function weightedNeighborRate(neighbors) {
  if (!neighbors.length) return 0;
  let weightedEvents = 0;
  let weightSum = 0;
  for (const neighbor of neighbors) {
    const weight = Math.max(0, neighbor.similarity) + 0.001;
    weightedEvents += weight * (neighbor.event ? 1 : 0);
    weightSum += weight;
  }
  return weightSum ? weightedEvents / weightSum : 0;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  const bValues = new Map(b.values);
  let dot = 0;
  for (const [token, value] of a.values) {
    dot += value * (bValues.get(token) || 0);
  }
  return dot / (a.norm * b.norm);
}

function auc(pairs) {
  const positives = pairs.filter((item) => item.event);
  const negatives = pairs.filter((item) => !item.event);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  let ties = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      if (pos.value > neg.value) wins += 1;
      else if (pos.value === neg.value) ties += 1;
    }
  }
  return (wins + 0.5 * ties) / (positives.length * negatives.length);
}

function renderMarkdown(report) {
  const lines = [
    "# Note Similarity Predictiveness Analysis",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Method",
    "",
    `Method: ${report.method.name}`,
    `Max terms: ${report.method.max_terms}`,
    `Neighbor counts: ${report.method.neighbor_counts.join(", ")}`,
    "",
    report.method.caution,
    ""
  ];

  for (const [model, summary] of Object.entries(report.models)) {
    lines.push(`## ${model}`, "", `Cases: ${summary.cases}`, "");
    lines.push("### Target Event Rates", "", "| Target | Events | Rate |", "| --- | ---: | ---: |");
    for (const [target, value] of Object.entries(summary.target_event_rates)) {
      lines.push(`| ${target} | ${Math.round(value * summary.cases)} | ${format(value)} |`);
    }
    lines.push("", "### Neighbor Prediction Performance", "");
    lines.push("| Target | k | AUC | Mean Score If Event | Mean Score If No Event | Top Decile Event Rate | Bottom Decile Event Rate |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [target, targetSummary] of Object.entries(summary.targets)) {
      for (const [k, values] of Object.entries(targetSummary.by_k)) {
        lines.push(`| ${target} | ${k} | ${formatNullable(values.auc)} | ${format(values.mean_score_event)} | ${format(values.mean_score_no_event)} | ${format(values.top_decile_event_rate)} | ${format(values.bottom_decile_event_rate)} |`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
  }
  return groups;
}

function eventRate(items) {
  return items.length ? items.filter((item) => item.event).length / items.length : 0;
}

function rate(items, fn) {
  return items.length ? items.filter(fn).length / items.length : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function formatNullable(value) {
  return value === null || value === undefined ? "N/A" : format(value);
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
