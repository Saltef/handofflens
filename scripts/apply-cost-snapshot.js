#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = required(args.input, "--input is required");
const pricingPath = required(args.pricing, "--pricing is required");
const outPath = required(args.out, "--out is required");
const report = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const pricing = JSON.parse(fs.readFileSync(pricingPath, "utf8"));

for (const [model, rates] of Object.entries(pricing.models || {})) {
  for (const key of ["input_usd_per_million_tokens", "output_usd_per_million_tokens"]) {
    if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error(`Pricing snapshot requires a non-negative numeric ${model}.${key}`);
  }
}

const results = (report.results || []).map((result) => {
  const rates = pricing.models?.[result.model];
  const usage = result.telemetry?.usage;
  if (!rates || !usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return { ...result, estimated_cost_usd: null };
  const billableInput = Number.isFinite(usage.billed_input_tokens) ? usage.billed_input_tokens : usage.input_tokens;
  const billableOutput = Number.isFinite(usage.billed_output_tokens) ? usage.billed_output_tokens : usage.output_tokens;
  return {
    ...result,
    estimated_cost_usd: (billableInput * rates.input_usd_per_million_tokens + billableOutput * rates.output_usd_per_million_tokens) / 1_000_000,
    cost_token_basis: Number.isFinite(usage.billed_input_tokens) || Number.isFinite(usage.billed_output_tokens) ? "provider_billed_tokens" : "reported_usage_tokens"
  };
});
const costByModel = {};
for (const result of results) {
  costByModel[result.model] ||= { cases_with_cost: 0, total_estimated_cost_usd: 0 };
  if (Number.isFinite(result.estimated_cost_usd)) {
    costByModel[result.model].cases_with_cost += 1;
    costByModel[result.model].total_estimated_cost_usd += result.estimated_cost_usd;
  }
}
for (const summary of Object.values(costByModel)) summary.mean_estimated_cost_usd = summary.cases_with_cost ? summary.total_estimated_cost_usd / summary.cases_with_cost : null;

const output = { ...report, pricing_snapshot: pricing, cost_summary: costByModel, results };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${outPath}`);

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[item.slice(2)] = true;
    else {
      parsed[item.slice(2)] = next;
      index += 1;
    }
  }
  return parsed;
}
