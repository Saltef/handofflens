#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const pA = numberArg(args["error-a"] ?? args["unsafe-a"], 0.30);
const pB = numberArg(args["error-b"] ?? args["unsafe-b"], 0.15);
const pBoth = numberArg(args["error-both"] ?? args["unsafe-both"], 0.10);
const targetPower = numberArg(args.power, 0.80);
const targetHalfWidth = numberArg(args["half-width"], 0.10);
const alpha = numberArg(args.alpha, 0.05);
const simulations = Math.round(numberArg(args.simulations, 10000));
const maxN = Math.round(numberArg(args.max, 2000));
const attrition = numberArg(args.attrition, 0.10);
const step = Math.round(numberArg(args.step, 10));

validateProbabilities();
const cells = { both: pBoth, a_only: pA - pBoth, b_only: pB - pBoth, neither: 1 - pA - pB + pBoth };
let selected = null;
const rows = [];
for (let n = 30; n <= maxN; n += step) {
  const result = simulate(n, simulations, cells, alpha);
  rows.push(result);
  if (result.power >= targetPower && result.expected_ci_half_width <= targetHalfWidth) {
    selected = result;
    break;
  }
}

const report = {
  status: "planning_assumptions_only_until_rates_come_from_blinded_probability_pilot_source_fidelity_labels",
  estimand: "paired risk difference in outputs with any semantic source-fidelity error",
  test: "two-sided exact McNemar test",
  assumptions: { error_a: pA, error_b: pB, error_both: pBoth, ...cells, alpha, target_power: targetPower, target_ci_half_width: targetHalfWidth, simulations, attrition, step },
  selected: selected ? { ...selected, target_generated_pairs: Math.ceil(selected.n / (1 - attrition)) } : null,
  evaluated: rows
};
const output = `${JSON.stringify(report, null, 2)}\n`;
if (args.out) require("node:fs").writeFileSync(args.out, output);
console.log(output.trim());
if (!selected) process.exitCode = 2;

function simulate(n, repeats, probabilities, alphaLevel) {
  let state = (20260618 + n) >>> 0;
  let rejected = 0;
  let halfWidthTotal = 0;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    let aOnly = 0;
    let bOnly = 0;
    for (let index = 0; index < n; index += 1) {
      state = (1664525 * state + 1013904223) >>> 0;
      const draw = state / 0x100000000;
      if (draw < probabilities.both) continue;
      if (draw < probabilities.both + probabilities.a_only) aOnly += 1;
      else if (draw < probabilities.both + probabilities.a_only + probabilities.b_only) bOnly += 1;
    }
    const discordant = aOnly + bOnly;
    if (discordant && exactMcNemarP(aOnly, bOnly) < alphaLevel) rejected += 1;
    const difference = (aOnly - bOnly) / n;
    const variance = Math.max(0, (discordant / n) - difference * difference) / n;
    halfWidthTotal += 1.959963984540054 * Math.sqrt(variance);
  }
  return { n, power: rejected / repeats, expected_ci_half_width: halfWidthTotal / repeats };
}

function exactMcNemarP(aOnly, bOnly) {
  const n = aOnly + bOnly;
  const k = Math.min(aOnly, bOnly);
  let term = 2 ** (-n);
  let cumulative = term;
  for (let i = 1; i <= k; i += 1) {
    term *= (n - i + 1) / i;
    cumulative += term;
  }
  return Math.min(1, 2 * cumulative);
}

function validateProbabilities() {
  if (![pA, pB, pBoth, targetPower, targetHalfWidth, alpha, attrition].every((value) => value >= 0 && value <= 1)) throw new Error("All probability arguments must be between 0 and 1");
  if (pBoth > Math.min(pA, pB) || 1 - pA - pB + pBoth < 0) throw new Error("The paired unsafe probabilities are not jointly feasible");
  if (attrition >= 1 || !Number.isInteger(step) || step < 1) throw new Error("Attrition must be below 1 and step must be a positive integer");
}

function numberArg(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric argument: ${value}`);
  return parsed;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const next = argv[index + 1];
    parsed[item.slice(2)] = next;
    index += 1;
  }
  return parsed;
}
