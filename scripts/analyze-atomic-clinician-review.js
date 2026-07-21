#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || "results/atomic-clinician-review-completed.json";
const keyPath = args.key || "results/atomic-clinician-review-model-key.json";
const outPath = args.out || "results/atomic-clinician-review-analysis.json";
const mdPath = args.mdout || outPath.replace(/\.json$/i, ".md");

if (!fs.existsSync(inputPath)) throw new Error(`Completed review file not found: ${inputPath}`);
if (!fs.existsSync(keyPath)) throw new Error(`Model key not found: ${keyPath}`);

const packet = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const key = JSON.parse(fs.readFileSync(keyPath, "utf8")).key || {};
const reviews = [];

for (const item of packet.cases || []) {
  for (const output of item.outputs || []) {
    const identity = key[`${item.case_id}:${output.model_slot}`];
    if (!identity) continue;
    reviews.push(buildReview(item, output, identity));
  }
}

const complete = reviews.filter((review) => review.complete);
const byModel = groupBy(complete, (review) => review.model);
const report = {
  generated_at: new Date().toISOString(),
  input_path: inputPath,
  reviewer_id: packet.reviewer_id || "",
  reviews_total: reviews.length,
  reviews_complete: complete.length,
  reviews_incomplete: reviews.length - complete.length,
  caution: "Claim-level estimates use a risk-enriched deterministic claim sample and are not unbiased prevalence estimates. Clinical conclusions require an independent adjudicated test set.",
  models: Object.fromEntries(Object.entries(byModel).map(([model, items]) => [model, summarizeModel(items)])),
  paired_comparison: summarizePairs(complete)
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(mdPath, renderMarkdown(report));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdPath}`);
console.log(`Completed reviews: ${complete.length}/${reviews.length}`);

function buildReview(item, output, identity) {
  const claimReviews = (output.claims || []).map((claim) => ({ ...claim.review, domain: claim.domain, relationship: claim.relationship }));
  const omissions = output.omissions || [];
  const global = output.global_review || {};
  const complete = claimReviews.every((claim) => claim.factual_support && claim.relationship_support && claim.severity) &&
    omissions.every((omission) => omission.status && omission.severity) &&
    Number.isInteger(global.source_record_match) && Number.isInteger(global.handover_safety) && Boolean(global.disposition);
  return {
    case_id: item.case_id,
    model_slot: output.model_slot,
    model: identity.model,
    provider: identity.provider,
    complete,
    claims: claimReviews,
    omissions,
    global
  };
}

function summarizeModel(items) {
  const claims = items.flatMap((item) => item.claims);
  const relationshipClaims = claims.filter((claim) => claim.relationship_support !== "not_applicable");
  const omissions = items.flatMap((item) => item.omissions);
  const unsafe = items.filter((item) => item.global.handover_safety <= 1 || item.global.source_record_match <= 1).length;
  return {
    output_reviews: items.length,
    audited_claims: claims.length,
    mean_source_record_match: mean(items.map((item) => item.global.source_record_match)),
    mean_handover_safety: mean(items.map((item) => item.global.handover_safety)),
    unsafe_output_count: unsafe,
    unsafe_output_rate: unsafe / items.length,
    unsafe_output_ci95: wilsonInterval(unsafe, items.length),
    factual_error_count: claims.filter((claim) => ["partially_supported", "unsupported"].includes(claim.factual_support)).length,
    factual_error_rate_in_audited_sample: rate(claims, (claim) => ["partially_supported", "unsupported"].includes(claim.factual_support)),
    factual_error_ci95_in_audited_sample: wilsonInterval(claims.filter((claim) => ["partially_supported", "unsupported"].includes(claim.factual_support)).length, claims.length),
    relationship_error_count: relationshipClaims.filter((claim) => ["partially_supported", "unsupported"].includes(claim.relationship_support)).length,
    relationship_error_rate_in_audited_sample: rate(relationshipClaims, (claim) => ["partially_supported", "unsupported"].includes(claim.relationship_support)),
    relationship_error_ci95_in_audited_sample: wilsonInterval(relationshipClaims.filter((claim) => ["partially_supported", "unsupported"].includes(claim.relationship_support)).length, relationshipClaims.length),
    material_or_harmful_claim_count: claims.filter((claim) => ["material", "potentially_harmful"].includes(claim.severity)).length,
    material_or_harmful_claim_rate_in_audited_sample: rate(claims, (claim) => ["material", "potentially_harmful"].includes(claim.severity)),
    outputs_with_important_omission: items.filter((item) => item.omissions.some((omission) => omission.status === "present" && ["material", "potentially_harmful"].includes(omission.severity))).length,
    important_omission_output_rate: rate(items, (item) => item.omissions.some((omission) => omission.status === "present" && ["material", "potentially_harmful"].includes(omission.severity))),
    important_omission_output_ci95: wilsonInterval(items.filter((item) => item.omissions.some((omission) => omission.status === "present" && ["material", "potentially_harmful"].includes(omission.severity))).length, items.length),
    dispositions: countBy(items.map((item) => item.global.disposition)),
    severity_counts: countBy(claims.map((claim) => claim.severity)),
    factual_support_counts: countBy(claims.map((claim) => claim.factual_support)),
    relationship_support_counts: countBy(relationshipClaims.map((claim) => claim.relationship_support)),
    omission_counts_by_domain: Object.fromEntries([...new Set(omissions.map((item) => item.domain))].sort().map((domain) => [domain, omissions.filter((item) => item.domain === domain && item.status === "present").length]))
  };
}

function summarizePairs(items) {
  const byCase = groupBy(items, (item) => item.case_id);
  const pairs = Object.values(byCase).filter((group) => group.length === 2 && new Set(group.map((item) => item.model)).size === 2);
  const models = [...new Set(pairs.flatMap((pair) => pair.map((item) => item.model)))].sort();
  if (models.length !== 2) return { completed_pairs: pairs.length, models, comparison_available: false };
  const [modelA, modelB] = models;
  let aUnsafeBNot = 0;
  let bUnsafeANot = 0;
  const differences = [];
  for (const pair of pairs) {
    const a = pair.find((item) => item.model === modelA);
    const b = pair.find((item) => item.model === modelB);
    const aUnsafe = a.global.handover_safety <= 1 || a.global.source_record_match <= 1;
    const bUnsafe = b.global.handover_safety <= 1 || b.global.source_record_match <= 1;
    if (aUnsafe && !bUnsafe) aUnsafeBNot += 1;
    if (bUnsafe && !aUnsafe) bUnsafeANot += 1;
    differences.push({
      case_id: a.case_id,
      source_match_difference_a_minus_b: a.global.source_record_match - b.global.source_record_match,
      safety_difference_a_minus_b: a.global.handover_safety - b.global.handover_safety
    });
  }
  return {
    completed_pairs: pairs.length,
    comparison_available: true,
    model_a: modelA,
    model_b: modelB,
    mean_source_match_difference_a_minus_b: mean(differences.map((item) => item.source_match_difference_a_minus_b)),
    source_match_difference_ci95: pairedBootstrapInterval(differences.map((item) => item.source_match_difference_a_minus_b)),
    mean_safety_difference_a_minus_b: mean(differences.map((item) => item.safety_difference_a_minus_b)),
    safety_difference_ci95: pairedBootstrapInterval(differences.map((item) => item.safety_difference_a_minus_b)),
    discordant_unsafe: { model_a_unsafe_only: aUnsafeBNot, model_b_unsafe_only: bUnsafeANot },
    case_differences: differences
  };
}

function renderMarkdown(output) {
  const lines = [
    "# Atomic Clinician Review Analysis",
    "",
    `Generated: ${output.generated_at}`,
    `Reviewer: ${output.reviewer_id || "not recorded"}`,
    `Completed reviews: ${output.reviews_complete}/${output.reviews_total}`,
    "",
    "## Interpretation Boundary",
    "",
    output.caution,
    "",
    "## Model Results",
    "",
    "| Model | Reviews | Unsafe output (95% CI) | Mean source match | Mean safety | Factual error* | Relationship error* | Important omission |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const [model, summary] of Object.entries(output.models)) {
    lines.push(`| ${model} | ${summary.output_reviews} | ${pct(summary.unsafe_output_rate)} (${formatInterval(summary.unsafe_output_ci95)}) | ${format(summary.mean_source_record_match)} | ${format(summary.mean_handover_safety)} | ${pct(summary.factual_error_rate_in_audited_sample)} | ${pct(summary.relationship_error_rate_in_audited_sample)} | ${pct(summary.important_omission_output_rate)} |`);
  }
  lines.push("", "\\* Risk-enriched audited claim sample; not an unbiased prevalence estimate.", "", "## Paired Comparison", "");
  const paired = output.paired_comparison;
  if (!paired.comparison_available) lines.push(`Completed model pairs: ${paired.completed_pairs}. A two-model paired comparison is not yet available.`);
  else {
    lines.push(`Completed pairs: ${paired.completed_pairs}`);
    lines.push(`Model A: ${paired.model_a}`);
    lines.push(`Model B: ${paired.model_b}`);
    lines.push(`Mean source-match difference, A minus B: ${format(paired.mean_source_match_difference_a_minus_b)}`);
    lines.push(`Patient-paired bootstrap 95% CI: ${formatInterval(paired.source_match_difference_ci95, false)}`);
    lines.push(`Mean safety difference, A minus B: ${format(paired.mean_safety_difference_a_minus_b)}`);
    lines.push(`Patient-paired bootstrap 95% CI: ${formatInterval(paired.safety_difference_ci95, false)}`);
    lines.push(`Discordant unsafe pairs: A only ${paired.discordant_unsafe.model_a_unsafe_only}; B only ${paired.discordant_unsafe.model_b_unsafe_only}.`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function rate(items, predicate) {
  return items.length ? items.filter(predicate).length / items.length : null;
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total)) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function pairedBootstrapInterval(values, repeats = 5000) {
  if (!values.length) return null;
  let state = 20260618;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const estimates = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(random() * values.length)];
    estimates.push(total / values.length);
  }
  estimates.sort((a, b) => a - b);
  return [estimates[Math.floor(0.025 * (repeats - 1))], estimates[Math.floor(0.975 * (repeats - 1))]];
}

function countBy(items) {
  const counts = {};
  for (const item of items.filter(Boolean)) counts[item] = (counts[item] || 0) + 1;
  return counts;
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

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function formatInterval(interval, percent = true) {
  if (!Array.isArray(interval) || interval.length !== 2) return "N/A";
  return percent ? `${pct(interval[0])}-${pct(interval[1])}` : `${format(interval[0])} to ${format(interval[1])}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const keyName = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[keyName] = true;
    else {
      parsed[keyName] = next;
      index += 1;
    }
  }
  return parsed;
}
