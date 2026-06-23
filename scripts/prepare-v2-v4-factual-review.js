#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const v2Path = args.v2 || "results/evidence-pointer-v2-final20-20260623/combined.json";
const v4Path = args.v4 || "results/candidate-first-v4-final20-20260623-extractive/combined.json";
const v2 = readJson(v2Path);
const v4 = readJson(v4Path);
const outDir = path.resolve(root, args["out-dir"] || "results/v2-v4-factual-review-30-20260623");
fs.mkdirSync(outDir, { recursive: true });

const a = inventory(v2.records, "v2"), b = inventory(v4.records, "v4");
const aByKey = group(a, (x) => comparisonKey(x)), bByKey = group(b, (x) => comparisonKey(x));
const shared = [];
for (const key of Object.keys(aByKey).filter((key) => bByKey[key])) {
  for (let i = 0; i < Math.min(aByKey[key].length, bByKey[key].length); i += 1) shared.push(makeShared(aByKey[key][i], bByKey[key][i]));
}
const v2Only = a.filter((item) => !bByKey[comparisonKey(item)]).map((item) => makeSingle(item, "exclusive_alpha"));
const v4Only = b.filter((item) => !aByKey[comparisonKey(item)]).map((item) => makeSingle(item, "exclusive_beta"));
const selected = [
  ...stratified(shared, 10),
  ...stratified(v2Only, 10),
  ...stratified(v4Only, 10)
].sort((x, y) => stableHash(x.review_id).localeCompare(stableHash(y.review_id)));

selected.forEach((item, index) => { item.review_id = `R${String(index + 1).padStart(3, "0")}`; });
const key = Object.fromEntries(selected.map((item) => [item.review_id, item._key]));
const packet = selected.map(({ _key, ...item }) => item);
const instructions = {
  support: ["yes", "partial", "no", "unclear"],
  category: ["correct", "incorrect", "unclear"],
  quote_completeness: ["complete", "partial", "malformed", "unclear"],
  transformation: ["verbatim", "explicit_equivalent", "standard_interpretation", "unsupported_inference", "unclear"],
  preferred_label_for_shared: ["A", "B", "equivalent", "neither", "not_applicable"],
  scope: "Judge factual support from the displayed quotation only. Do not judge clinical importance, severity, safety, or appropriate care."
};
fs.writeFileSync(path.join(outDir, "review-packet.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), source_results: { v2: v2Path, v4: v4Path }, instructions, counts: countBy(packet.map((x) => x.comparison_group)), items: packet }, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "private-method-key.json"), `${JSON.stringify({ generated_at: new Date().toISOString(), key }, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "review-template.csv"), csv(packet));
fs.writeFileSync(path.join(outDir, "review-packet.md"), markdown(packet, instructions));
console.log(JSON.stringify({ output: outDir, counts: countBy(packet.map((x) => x.comparison_group)), domains: countBy(packet.map((x) => x.domain)) }, null, 2));

function inventory(records, method) {
  const out = [];
  for (const record of records) {
    const extraction = record.extraction;
    if (!extraction) continue;
    for (const [domain, list] of lists(extraction)) for (const item of list || []) out.push({ method, case_id: record.case_id, domain, label: item.label, rationale: item.rationale, source_quote: item.source_quote });
  }
  return out;
}
function lists(e) { return [...Object.entries(e.medication_changes || {}).map(([key, value]) => [`medication_changes.${key}`, value]), ["diagnosis_changes.discharge", e.diagnosis_changes?.discharge], ["diagnosis_changes.new_or_changed", e.diagnosis_changes?.new_or_changed], ...["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"].map((key) => [key, e[key]])]; }
function comparisonKey(x) { return `${x.case_id}|${broadDomain(x.domain)}|${normalize(x.source_quote)}`; }
function makeShared(left, right) {
  const swap = parseInt(stableHash(comparisonKey(left)).slice(0, 2), 16) % 2 === 1;
  const A = swap ? right : left, B = swap ? left : right;
  return { review_id: `shared:${comparisonKey(left)}`, comparison_group: "shared", case_id: left.case_id, domain: broadDomain(left.domain), source_quote: left.source_quote, output_a: { label: A.label, rationale: A.rationale, category: A.domain }, output_b: { label: B.label, rationale: B.rationale, category: B.domain }, _key: { group: "shared", A: A.method, B: B.method, left, right } };
}
function makeSingle(item, group) { return { review_id: `${group}:${comparisonKey(item)}:${normalize(item.label)}`, comparison_group: group, case_id: item.case_id, domain: broadDomain(item.domain), source_quote: item.source_quote, output_a: { label: item.label, rationale: item.rationale, category: item.domain }, output_b: null, _key: { group, method: item.method, item } }; }
function stratified(values, n) {
  const buckets = group(values, (x) => x.domain), domains = Object.keys(buckets).sort(), selected = [], used = new Set();
  for (const domain of domains) buckets[domain].sort((x, y) => stableHash(x.review_id).localeCompare(stableHash(y.review_id)));
  let cursor = 0;
  while (selected.length < Math.min(n, values.length)) {
    const domain = domains[cursor % domains.length], candidate = buckets[domain].shift(); cursor += 1;
    if (candidate && !used.has(candidate.review_id)) { used.add(candidate.review_id); selected.push(candidate); }
    if (cursor > values.length * domains.length + 100) break;
  }
  if (selected.length < n) for (const item of [...values].sort((x, y) => stableHash(x.review_id).localeCompare(stableHash(y.review_id)))) if (!used.has(item.review_id) && selected.length < n) { used.add(item.review_id); selected.push(item); }
  return selected;
}
function csv(items) {
  const columns = ["review_id", "comparison_group", "case_id", "domain", "source_quote", "output_a_label", "output_a_rationale", "output_a_category", "output_b_label", "output_b_rationale", "output_b_category", "quote_completeness", "support_a", "category_a", "transformation_a", "support_b", "category_b", "transformation_b", "preferred_label", "duplicate_or_redundant", "reviewer_notes"];
  const rows = items.map((x) => [x.review_id, x.comparison_group, x.case_id, x.domain, x.source_quote, x.output_a.label, x.output_a.rationale, x.output_a.category, x.output_b?.label || "", x.output_b?.rationale || "", x.output_b?.category || "", "", "", "", "", "", "", "", x.output_b ? "" : "not_applicable", "", ""]);
  return `${columns.map(q).join(",")}\n${rows.map((row) => row.map(q).join(",")).join("\n")}\n`;
}
function markdown(items, instructions) { return `# Blinded v2/v4 factual review\n\n${instructions.scope}\n\nAllowed support labels: ${instructions.support.join(", ")}. Allowed category labels: ${instructions.category.join(", ")}.\nQuote completeness: ${instructions.quote_completeness.join(", ")}. Transformation: ${instructions.transformation.join(", ")}.\n\nA standard medical interpretation is not direct quotation support unless the quotation explicitly states the equivalent meaning. Use the CSV template to record decisions.\n\n${items.map((x) => `## ${x.review_id} — ${x.domain}\n\nCase: ${x.case_id}\n\n> ${x.source_quote.replace(/\n/g, "\n> ")}\n\nOutput A: **${x.output_a.label}**  \nCategory: ${x.output_a.category}  \nRationale: ${x.output_a.rationale}\n${x.output_b ? `\nOutput B: **${x.output_b.label}**  \nCategory: ${x.output_b.category}  \nRationale: ${x.output_b.rationale}\n` : ""}`).join("\n")}\n`; }
function broadDomain(value) { return String(value).split(".")[0]; }
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function stableHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function group(values, key) { const out = {}; for (const value of values) (out[key(value)] ||= []).push(value); return out; }
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((x) => x === value).length])); }
function q(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }
function readJson(relativePath) {
  const fullPath = path.resolve(root, relativePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Missing input artifact: ${relativePath}`);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
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
