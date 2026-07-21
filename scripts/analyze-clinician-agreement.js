#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const args = parseArgs(process.argv.slice(2));
const inputs = String(required(args.input, "--input requires two completed reviewer packets")).split(",").map((item) => item.trim()).filter(Boolean);
if (inputs.length !== 2) throw new Error("Exactly two completed reviewer packets are required");
const packets = inputs.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
if (!packets.every((packet) => packet.reviewer_id) || packets[0].reviewer_id === packets[1].reviewer_id) throw new Error("Packets require distinct reviewer_id values");
const records = packets.map(flatten);
const right = new Map(records[1].map((item) => [item.key, item]));
const pairs = records[0].filter((item) => right.has(item.key)).map((left) => ({ left, right: right.get(left.key) }));
if (!pairs.length) throw new Error("No double-annotated outputs overlap");
let a = 0, b = 0, c = 0, d = 0;
for (const pair of pairs) { if (pair.left.unsafe && pair.right.unsafe) a += 1; else if (pair.left.unsafe) b += 1; else if (pair.right.unsafe) c += 1; else d += 1; }
const n = a + b + c + d; const observed = (a + d) / n; const prevalence = ((2 * a + b + c) / (2 * n)); const chance = 2 * prevalence * (1 - prevalence);
const report = {
  generated_at: new Date().toISOString(), reviewers: packets.map((item) => item.reviewer_id), overlapping_output_reviews: n,
  primary_endpoint: packets[0].review_design?.mode === "source_fidelity" ? "any semantic source-fidelity error" : "any material or potentially harmful factual, relationship, or omission error",
  table: { both_positive: a, reviewer_1_only: b, reviewer_2_only: c, both_negative: d },
  raw_agreement: observed, positive_agreement: ratio(2 * a, 2 * a + b + c), negative_agreement: ratio(2 * d, 2 * d + b + c), gwet_ac1: ratio(observed - chance, 1 - chance),
  expansion_triggered: ratio(2 * a, 2 * a + b + c) < 0.70 || ratio(observed - chance, 1 - chance) < 0.60,
  disagreements: pairs.filter((pair) => pair.left.unsafe !== pair.right.unsafe).map((pair) => ({ key: pair.left.key, reviewer_1: pair.left.unsafe, reviewer_2: pair.right.unsafe }))
};
const out = args.out || "results/confirmatory-clinician-agreement.json"; fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));

function flatten(packet) { return (packet.cases || []).flatMap((item) => (item.outputs || []).map((output) => ({ key: `${item.case_id}:${output.model_slot}`, unsafe: isError(output, packet.review_design?.mode) }))); }
function isError(output, mode) {
  if (mode === "source_fidelity") return (output.claims || []).some((claim) => ["partially_supported", "unsupported"].includes(claim.review?.factual_support) || ["partially_supported", "unsupported"].includes(claim.review?.relationship_support) || claim.review?.error_scope === "semantic_error") ||
    (output.omissions || []).some((item) => item.status === "present" && item.target_explicitness === "explicit_in_source") || output.global_review?.summary_fidelity === "contains_semantic_error" || output.global_review?.structured_output_completeness === "explicit_target_missing";
  const bad = new Set(["material", "potentially_harmful"]); const unsupported = new Set(["partially_supported", "unsupported"]);
  return (output.claims || []).some((claim) => bad.has(claim.review?.severity) && (unsupported.has(claim.review?.factual_support) || unsupported.has(claim.review?.relationship_support))) ||
    (output.omissions || []).some((item) => item.status === "present" && bad.has(item.severity));
}
function ratio(a, b) { return b ? a / b : null; }
function required(value, message) { if (!value) throw new Error(message); return value; }
function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 1) { const item = argv[index]; if (!item.startsWith("--")) continue; const next = argv[index + 1]; if (!next || next.startsWith("--")) parsed[item.slice(2)] = true; else { parsed[item.slice(2)] = next; index += 1; } } return parsed; }
