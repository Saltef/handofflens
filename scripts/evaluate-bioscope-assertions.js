#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { detectAssertionStatus } = require("./clinical-validation-signals");

function parseArgs(argv) {
  const args = { out: "results/bioscope-assertions.json", corpus: "all", "target-mode": "sentence" };
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

function evaluateBioScopeAssertions(inputs, options = {}) {
  const files = expandInputs(inputs);
  const examples = options.examples || files.flatMap((filePath) => parseBioScopeXml(fs.readFileSync(filePath, "utf8"), filePath));
  const targetMode = options.targetMode || options["target-mode"] || "sentence";
  const filtered = options.corpus && options.corpus !== "all"
    ? examples.filter((example) => example.corpus === options.corpus)
    : examples;
  const evaluated = filtered.map((example) => {
    const assertionInput = assertionInputForExample(example, targetMode);
    const detectedRaw = detectAssertionStatus({
      sourceText: assertionInput.sourceText,
      quote: assertionInput.quote,
      label: assertionInput.label,
      windowChars: 220,
    }).status;
    return {
      ...example,
      detected_status: collapseStatus(detectedRaw),
      detected_raw_status: detectedRaw,
    };
  });
  const labels = ["present", "absent", "possible"];
  return {
    generated_at: new Date().toISOString(),
    schema_version: "bioscope-assertion-eval-v1",
    corpus: options.corpus || "all",
    target_mode: targetMode,
    uses_gold_scope_text: targetMode === "scope",
    files: files.map((filePath) => path.basename(filePath)),
    summary: summarize(evaluated, labels),
    by_corpus: Object.fromEntries([...new Set(evaluated.map((item) => item.corpus))].sort().map((corpus) => [corpus, summarize(evaluated.filter((item) => item.corpus === corpus), labels)])),
    confusion: confusion(evaluated, labels),
    interpretation: targetMode === "scope"
      ? "Scope-assisted BioScope cue diagnostic. Gold labels collapse negation to absent, speculation to possible, and unmarked sentences to present; the detector receives the BioScope xcope text as its quote. This is not a standard BioScope scope-boundary result and is not the primary sentence-only benchmark."
      : "Sentence-only BioScope cue benchmark. Gold labels collapse negation to absent, speculation to possible, and unmarked sentences to present. This evaluates assertion cue behavior from sentence text, not full scope boundary detection.",
  };
}

function assertionInputForExample(example, targetMode = "sentence") {
  if (targetMode === "scope") {
    const target = example.scope_text || example.text;
    return { sourceText: example.text, quote: target, label: target };
  }
  return { sourceText: example.text, quote: example.text, label: example.text };
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

function parseBioScopeXml(xml, filePath) {
  const corpus = corpusName(filePath);
  const examples = [];
  const fileName = path.basename(filePath);
  const documentRe = /<Document\b([^>]*)>([\s\S]*?)<\/Document>/gi;
  let documentMatch;
  let documentIndex = 0;
  while ((documentMatch = documentRe.exec(xml))) {
    documentIndex += 1;
    const documentId = attr(documentMatch[1], "id") || `${fileName}:doc-${documentIndex}`;
    examples.push(...parseBioScopeSentences(documentMatch[2], { corpus, fileName, documentId, offset: examples.length }));
  }
  if (!documentIndex) examples.push(...parseBioScopeSentences(xml, { corpus, fileName, documentId: `${fileName}:doc-1`, offset: 0 }));
  return examples;
}

function parseBioScopeSentences(xml, context) {
  const examples = [];
  const sentenceRe = /<sentence\b([^>]*)>([\s\S]*?)<\/sentence>/gi;
  let match;
  while ((match = sentenceRe.exec(xml))) {
    const id = attr(match[1], "id") || `${context.fileName}:${context.offset + examples.length + 1}`;
    const inner = match[2];
    const cueTypes = [...inner.matchAll(/<cue\b[^>]*type="([^"]+)"/gi)].map((cueMatch) => cueMatch[1].toLowerCase());
    const xcopeTexts = [...inner.matchAll(/<xcope\b[^>]*>([\s\S]*?)<\/xcope>/gi)].map((scopeMatch) => normalizeText(stripTags(scopeMatch[1])));
    const text = normalizeText(stripTags(inner));
    if (!text) continue;
    const gold = cueTypes.includes("speculation") ? "possible" : cueTypes.includes("negation") ? "absent" : "present";
    examples.push({
      id,
      document_id: context.documentId,
      source_file: context.fileName,
      corpus: context.corpus,
      gold_status: gold,
      cue_types: [...new Set(cueTypes)].sort(),
      text,
      scope_text: xcopeTexts.sort((a, b) => b.length - a.length)[0] || text,
    });
  }
  return examples;
}

function summarize(rows, labels) {
  const perClass = {};
  for (const label of labels) {
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
    class_counts: Object.fromEntries(labels.map((label) => [label, rows.filter((row) => row.gold_status === label).length])),
    accuracy: ratio(correct, rows.length),
    macro_f1: labels.reduce((sum, label) => sum + perClass[label].f1, 0) / labels.length,
    per_class: perClass,
  };
}

function confusion(rows, labels) {
  return Object.fromEntries(labels.map((gold) => [gold, Object.fromEntries(labels.map((detected) => [detected, rows.filter((row) => row.gold_status === gold && row.detected_status === detected).length]))]));
}

function collapseStatus(status) {
  if (status === "absent") return "absent";
  if (["possible", "hypothetical", "conditional"].includes(status)) return "possible";
  return "present";
}

function corpusName(filePath) {
  const name = filePath.toLowerCase();
  if (name.includes("clinical")) return "clinical";
  if (name.includes("abstract")) return "abstracts";
  if (name.includes("full_paper")) return "full_papers";
  return "unknown";
}

function attr(value, name) {
  const match = new RegExp(`${name}="([^"]+)"`, "i").exec(value);
  return match ? match[1] : "";
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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
  const report = evaluateBioScopeAssertions(inputs, { corpus: args.corpus, targetMode: args["target-mode"] });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

if (require.main === module) main();
module.exports = { evaluateBioScopeAssertions, parseBioScopeXml, collapseStatus, assertionInputForExample };
