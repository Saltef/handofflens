#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readRows } = require("./adapt-aci-bench");
const { scoreAciNoteGeneration } = require("./score-aci-note-generation");
const { scoreAciNoteFactuality } = require("./score-aci-note-factuality");
const { BASELINE_METHODS, generateAciNoteBaselineRows } = require("./generate-aci-note-baselines");

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-baseline-comparison.json",
    split: "unknown",
    methods: BASELINE_METHODS.join(","),
    "prediction-field": "generated_note",
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

function evaluateAciNoteBaselines(rows, options = {}) {
  const split = options.split || "unknown";
  const methods = methodList(options.methods);
  const predictionField = options.predictionField || options["prediction-field"] || "generated_note";
  const bootstrapRepeats = Number(options.bootstrapRepeats ?? options["bootstrap-repeats"] ?? 1000);
  const reports = {};

  for (const method of methods) {
    const generated = generateAciNoteBaselineRows(rows, { method, predictionField, tokenBudget: options.tokenBudget ?? options["token-budget"] });
    const note = scoreAciNoteGeneration(generated.records, { split, predictionField, bootstrapRepeats });
    const factuality = scoreAciNoteFactuality(generated.records, { split, predictionField });
    reports[method] = {
      description: methodDescription(method),
      generation_summary: generated.summary,
      rouge_summary: note.summary,
      source_support_summary: factuality.summary,
    };
  }

  const ranking = Object.entries(reports)
    .map(([method, report]) => ({
      method,
      rouge1_f1: report.rouge_summary.metrics.rouge1.f1,
      rouge2_f1: report.rouge_summary.metrics.rouge2.f1,
      rougeL_f1: report.rouge_summary.metrics.rougeL.f1,
      source_token_support_rate: report.source_support_summary.mean_source_token_support_rate,
      source_bigram_support_rate: report.source_support_summary.mean_source_bigram_support_rate,
      novel_token_rate: report.source_support_summary.mean_novel_token_rate,
    }))
    .sort((left, right) => (
      (right.rougeL_f1 - left.rougeL_f1)
      || (right.rouge2_f1 - left.rouge2_f1)
      || (right.source_token_support_rate - left.source_token_support_rate)
    ));
  const generatedRanking = ranking.filter((item) => item.method !== "source_full");

  return {
    generated_at: new Date().toISOString(),
    schema_version: "aci-note-baseline-comparison-v1",
    split,
    prediction_field: predictionField,
    methods: reports,
    ranking,
    generated_ranking: generatedRanking,
    diagnostic_baseline_method: "source_full",
    selected_method: generatedRanking[0]?.method || null,
    selection_rule: "Report source_full as a transcript/reference diagnostic, but choose the compressed generated-note baseline by highest ROUGE-L F1, then ROUGE-2 F1, then source-token support.",
    interpretation: "Native ACI note-generation baseline comparison. These are deterministic extractive baselines, not LLM or official leaderboard submissions. Source-support metrics are lexical groundedness proxies, not clinical factuality.",
  };
}

function methodList(value) {
  if (Array.isArray(value)) return value;
  return String(value || BASELINE_METHODS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
}

function methodDescription(method) {
  const descriptions = {
    source_full: "Use the full source conversation as the prediction. This is an ingestion/overlap baseline, not generation.",
    lead_reference_length: "Use the first source tokens up to the reference-note token count.",
    tail_reference_length: "Use the final source tokens up to the reference-note token count.",
    cue_sentence_extractive: "Select source sentences with medication, follow-up, result, assessment, and procedure cues up to the reference-note token count.",
  };
  return descriptions[method] || "Undocumented method.";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.records;
  if (!input) {
    console.error("--input or --records is required");
    process.exit(1);
  }
  const report = evaluateAciNoteBaselines(readRows(input), {
    split: args.split,
    methods: args.methods,
    predictionField: args["prediction-field"],
    bootstrapRepeats: args["bootstrap-repeats"],
    tokenBudget: args["token-budget"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ split: report.split, ranking: report.ranking, selected_method: report.selected_method }, null, 2));
}

if (require.main === module) main();
module.exports = { evaluateAciNoteBaselines };
