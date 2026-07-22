#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { detectAssertionStatus } = require("./clinical-validation-signals");
const { parseBioScopeXml, collapseStatus, assertionInputForExample } = require("./evaluate-bioscope-assertions");

const LABELS = ["present", "absent", "possible"];
const DEFAULT_METHODS = ["present_majority", "negex_style", "context_style", "handofflens_assertion"];

function parseArgs(argv) {
  const args = {
    out: "results/bioscope-baselines.json",
    corpus: "all",
    "target-mode": "sentence",
    methods: DEFAULT_METHODS.join(","),
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

function evaluateBioScopeBaselines(inputs, options = {}) {
  const files = expandInputs(inputs);
  const examples = options.examples || files.flatMap((filePath) => parseBioScopeXml(fs.readFileSync(filePath, "utf8"), filePath));
  const corpus = options.corpus || "all";
  const targetMode = options.targetMode || options["target-mode"] || "sentence";
  const methodIds = methodList(options.methods);
  const filtered = corpus && corpus !== "all" ? examples.filter((example) => example.corpus === corpus) : examples;
  const methods = {};

  for (const methodId of methodIds) {
    const rows = filtered.map((example) => ({
      ...example,
      detected_status: predictBioScopeBaseline(example, methodId, { targetMode }),
    }));
    methods[methodId] = {
      description: methodDescription(methodId),
      summary: summarize(rows),
      by_corpus: Object.fromEntries([...new Set(rows.map((row) => row.corpus))].sort().map((item) => [item, summarize(rows.filter((row) => row.corpus === item))])),
      confusion: confusion(rows),
    };
  }

  const ranked = Object.entries(methods)
    .map(([method, report]) => ({
      method,
      macro_f1: report.summary.macro_f1,
      accuracy: report.summary.accuracy,
      absent_recall: report.summary.per_class.absent.recall,
      possible_recall: report.summary.per_class.possible.recall,
    }))
    .sort((left, right) => (right.macro_f1 - left.macro_f1) || (right.accuracy - left.accuracy));

  return {
    generated_at: new Date().toISOString(),
    schema_version: "bioscope-baseline-comparison-v1",
    corpus,
    target_mode: targetMode,
    uses_gold_scope_text: targetMode === "scope",
    files: files.map((filePath) => path.basename(filePath)),
    labels: LABELS,
    methods,
    ranking: ranked,
    primary_method: "handofflens_assertion",
    comparators_not_run: [
      {
        comparator: "official_pyConTextNLP_or_NegEx_package",
        status: "not_run",
        reason: "No external Python comparator package is vendored in the public repo. The included negex_style/context_style rows are transparent same-task approximations, not official package results.",
      },
      {
        comparator: "small_transformer_assertion_model",
        status: "not_run",
        reason: "No local transformer assertion model weights are shipped in the repo. Downloading model weights would require an explicit network/model-selection step.",
      },
    ],
    interpretation: targetMode === "scope"
      ? "Scope-assisted baseline comparison for the collapsed BioScope assertion task. This uses BioScope xcope text and must not be presented as the primary benchmark."
      : "Sentence-only baseline comparison for the collapsed BioScope assertion task. This is still not the standard BioScope scope-boundary task, but it is a fairer same-input comparison for cue-level assertion behavior.",
  };
}

function predictBioScopeBaseline(example, methodId, options = {}) {
  const targetMode = options.targetMode || "sentence";
  if (methodId === "present_majority") return "present";
  if (methodId === "negex_style") return negexStyle(example, targetMode);
  if (methodId === "context_style") return contextStyle(example, targetMode);
  if (methodId === "handofflens_assertion") {
    const assertionInput = assertionInputForExample(example, targetMode);
    return collapseStatus(detectAssertionStatus({
      sourceText: assertionInput.sourceText,
      quote: assertionInput.quote,
      label: assertionInput.label,
      windowChars: 220,
    }).status);
  }
  throw new Error(`Unknown BioScope baseline method: ${methodId}`);
}

function negexStyle(example, targetMode) {
  const text = baselineText(example, targetMode);
  return hasNegationCue(text) ? "absent" : "present";
}

function contextStyle(example, targetMode) {
  const text = baselineText(example, targetMode);
  if (hasSpeculationCue(text)) return "possible";
  if (hasNegationCue(text)) return "absent";
  return "present";
}

function baselineText(example, targetMode) {
  return normalize(targetMode === "scope" ? (example.scope_text || example.text) : example.text);
}

function hasNegationCue(text) {
  const cleaned = removePseudoNegation(text);
  return [
    /\bno\b/,
    /\bnot\b/,
    /\bnever\b/,
    /\bwithout\b/,
    /\bdenies?\b/,
    /\bdenied\b/,
    /\bnegative for\b/,
    /\bno evidence of\b/,
    /\bruled out\b/,
    /\babsence of\b/,
    /\bfree of\b/,
  ].some((pattern) => pattern.test(cleaned));
}

function hasSpeculationCue(text) {
  return [
    /\bpossible\b/,
    /\bpossibly\b/,
    /\bprobable\b/,
    /\bprobably\b/,
    /\bsuspected\b/,
    /\bconcern for\b/,
    /\bquestion of\b/,
    /\bmay\b/,
    /\bmight\b/,
    /\bcould\b/,
    /\bcannot exclude\b/,
    /\brule out\b/,
    /\br\/o\b/,
    /\bsuggests?\b/,
    /\bsuggested\b/,
    /\bsuggesting\b/,
    /\bindicates?\b/,
    /\bindicated\b/,
    /\bindicating\b/,
    /\bappears?\b/,
    /\bappeared\b/,
    /\blikely\b/,
    /\bpossibility\b/,
    /\bpotentially\b/,
    /\bputative\b/,
    /\bwhether\b/,
  ].some((pattern) => pattern.test(text));
}

function removePseudoNegation(text) {
  return text
    .replace(/\bnot only\b/g, " ")
    .replace(/\bnot necessarily\b/g, " ")
    .replace(/\bnot uncommon\b/g, " ")
    .replace(/\bwithout doubt\b/g, " ");
}

function methodList(value) {
  if (Array.isArray(value)) return value;
  return String(value || DEFAULT_METHODS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
}

function methodDescription(methodId) {
  const descriptions = {
    present_majority: "Always predicts present. This anchors accuracy and macro-F1 against the dominant class.",
    negex_style: "Transparent NegEx-style cue baseline: predicts absent for sentence/scope text containing negation cues, otherwise present. It does not model uncertainty.",
    context_style: "Transparent ConText-style cue baseline: predicts possible for speculation cues, absent for negation cues, otherwise present. It is cue-level, not scope-boundary resolution.",
    handofflens_assertion: "Current HandoffLens assertion detector with the same target mode as the baselines.",
  };
  return descriptions[methodId] || "Undocumented method.";
}

function summarize(rows) {
  const perClass = {};
  for (const label of LABELS) {
    const tp = rows.filter((row) => row.gold_status === label && row.detected_status === label).length;
    const fp = rows.filter((row) => row.gold_status !== label && row.detected_status === label).length;
    const fn = rows.filter((row) => row.gold_status === label && row.detected_status !== label).length;
    perClass[label] = {
      true_positives: tp,
      false_positives: fp,
      false_negatives: fn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
      f1: f1(tp, fp, fn),
      precision_ci95: wilson(tp, tp + fp),
      recall_ci95: wilson(tp, tp + fn),
    };
  }
  const correct = rows.filter((row) => row.gold_status === row.detected_status).length;
  return {
    examples: rows.length,
    class_counts: Object.fromEntries(LABELS.map((label) => [label, rows.filter((row) => row.gold_status === label).length])),
    accuracy: ratio(correct, rows.length),
    macro_f1: LABELS.reduce((sum, label) => sum + perClass[label].f1, 0) / LABELS.length,
    macro_recall: LABELS.reduce((sum, label) => sum + (perClass[label].recall || 0), 0) / LABELS.length,
    per_class: perClass,
  };
}

function confusion(rows) {
  return Object.fromEntries(LABELS.map((gold) => [gold, Object.fromEntries(LABELS.map((detected) => [detected, rows.filter((row) => row.gold_status === gold && row.detected_status === detected).length]))]));
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

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9/]+/g, " ").replace(/\s+/g, " ").trim();
}

function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = String(args.input || "").split(";").filter(Boolean);
  if (!inputs.length) {
    console.error("--input is required; use semicolon-separated XML paths or directories");
    process.exit(1);
  }
  const report = evaluateBioScopeBaselines(inputs, {
    corpus: args.corpus,
    targetMode: args["target-mode"],
    methods: args.methods,
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ target_mode: report.target_mode, ranking: report.ranking, primary: report.methods[report.primary_method].summary }, null, 2));
}

if (require.main === module) main();
module.exports = { evaluateBioScopeBaselines, predictBioScopeBaseline };
