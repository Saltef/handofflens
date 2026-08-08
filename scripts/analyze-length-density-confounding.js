#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { rateSummary, formatRate, round, mean } = require("./experiment-metrics");

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-length-density.json");
  const report = analyzeLengthDensityConfounding(JSON.parse(fs.readFileSync(inputPath, "utf8")), {
    shortWordThreshold: Number(args["short-word-threshold"] || 1500),
    highDensityThreshold: Number(args["high-density-threshold"] || 16),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(args.mdout || outPath.replace(/\.json$/i, ".md"), renderMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeLengthDensityConfounding(provenanceReport, options = {}) {
  const shortWordThreshold = Number(options.shortWordThreshold || 1500);
  const highDensityThreshold = Number(options.highDensityThreshold || 16);
  const cases = (provenanceReport.cases || [])
    .filter((item) => item.success && item.evidence_items > 0 && item.source_word_count > 0)
    .map((item) => ({
      ...item,
      claim_density_per_1k_words: item.evidence_items / item.source_word_count * 1000,
      length_bucket: item.source_word_count < shortWordThreshold ? "short" : "long",
      density_bucket: item.evidence_items / item.source_word_count * 1000 >= highDensityThreshold ? "high_density" : "low_density",
    }));
  const cells = {};
  for (const lengthBucket of ["short", "long"]) {
    for (const densityBucket of ["low_density", "high_density"]) {
      const key = `${lengthBucket}_${densityBucket}`;
      cells[key] = summarizeCases(cases.filter((item) => item.length_bucket === lengthBucket && item.density_bucket === densityBucket));
    }
  }
  const shortHigh = cells.short_high_density;
  const longLow = cells.long_low_density;
  const enoughOffDiagonal = shortHigh.records >= 3 && longLow.records >= 3;
  const spanIntervalsSeparated = enoughOffDiagonal && intervalsSeparated(
    shortHigh.span_supported_item_rate.wilson_95,
    longLow.span_supported_item_rate.wilson_95,
  );
  let conclusion = "off_diagonal_cells_too_thin";
  if (enoughOffDiagonal) {
    conclusion = spanIntervalsSeparated && shortHigh.span_supported_item_rate.rate < longLow.span_supported_item_rate.rate
      ? "density_signal_stronger_than_length_on_this_slice"
      : "length_and_density_associated_but_not_disentangled";
  }
  return {
    generated_at: new Date().toISOString(),
    schema_version: "length-density-confounding-v1",
    unit: "completed source record and evidence item",
    thresholds: {
      short_word_count_lt: shortWordThreshold,
      high_density_items_per_1k_words_gte: highDensityThreshold,
    },
    summary: {
      completed_records: cases.length,
      cells,
      off_diagonal_records: {
        short_high_density: shortHigh.records,
        long_low_density: longLow.records,
      },
      conclusion,
    },
    interpretation: "Off-diagonal diagnostic for the note-length versus claim-density confound. Rates are item-level unless labeled as records. If short/high-density and long/low-density cells are thin or intervals overlap, the honest claim is association rather than causal separation.",
  };
}

function summarizeCases(cases) {
  const items = cases.reduce((sum, item) => sum + item.evidence_items, 0);
  const exact = cases.reduce((sum, item) => sum + item.exact_quote_items, 0);
  const span = cases.reduce((sum, item) => sum + item.span_supported_items, 0);
  const abstain = cases.reduce((sum, item) => sum + item.provenance_abstain_items, 0);
  return {
    records: cases.length,
    evidence_items: items,
    mean_source_words: round(mean(cases.map((item) => item.source_word_count))),
    mean_density_per_1k_words: round(mean(cases.map((item) => item.claim_density_per_1k_words))),
    exact_quote_item_rate: rateSummary(exact, items),
    span_supported_item_rate: rateSummary(span, items),
    provenance_abstain_item_rate: rateSummary(abstain, items),
  };
}

function intervalsSeparated(left, right) {
  if (!left || !right) return false;
  return left[1] < right[0] || right[1] < left[0];
}

function renderMarkdown(report) {
  const lines = [
    "# Length Versus Claim-Density Confounding",
    "",
    report.interpretation,
    "",
    "## Summary",
    "",
    `Unit: ${report.unit}`,
    `Short note threshold: <${report.thresholds.short_word_count_lt} words`,
    `High-density threshold: >=${report.thresholds.high_density_items_per_1k_words_gte} evidence items per 1k words`,
    `Conclusion: \`${report.summary.conclusion}\``,
    "",
    "| Cell | Records | Evidence items | Mean words | Mean density | Exact item rate | Span-supported item rate | Abstain item rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [cell, values] of Object.entries(report.summary.cells)) {
    lines.push(`| \`${cell}\` | ${values.records} | ${values.evidence_items} | ${formatNumber(values.mean_source_words)} | ${formatNumber(values.mean_density_per_1k_words)} | ${formatRate(values.exact_quote_item_rate)} | ${formatRate(values.span_supported_item_rate)} | ${formatRate(values.provenance_abstain_item_rate)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatNumber(value) {
  return value === null || value === undefined ? "N/A" : Number(value).toFixed(3);
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

module.exports = { analyzeLengthDensityConfounding, renderMarkdown };
