"use strict";

// Analyze conformal-support-v1: case-clustered conformal risk control over the
// extracted-item support decision. Splits at the CASE level (exchangeability),
// averages over many seeded splits, reports realized risk / coverage / recall
// and the false-support reason breakdown. Pure analysis; no model calls.

const fs = require("node:fs");
const path = require("node:path");
const { calibrateThreshold, evaluate } = require("./conformal-risk-control");

const ITEMS_PATH = process.argv[2] || path.join("results", "conformal-support-items.json");
const OUT_MD = process.argv[3] || null;
const ALPHAS = [0.05, 0.1, 0.2];
const SPLITS = 200;
const CAL_FRAC = 0.5;

let _s = 0x1234567;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

function main() {
  const data = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));
  const records = data.records;
  const byCase = {};
  for (const r of records) (byCase[r.case_id] ||= []).push(r);
  const caseIds = Object.keys(byCase);

  const overall = {
    items: records.length,
    supported: records.filter((r) => r.supported).length,
    unsupported: records.filter((r) => !r.supported).length,
  };
  const reasonCounts = {};
  for (const r of records) if (!r.supported) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;

  const perAlpha = [];
  for (const alpha of ALPHAS) {
    const risks = [], covs = [], recalls = [], lambdas = [], faAcc = [];
    let overCount = 0;
    for (let s = 0; s < SPLITS; s++) {
      const shuffled = shuffle(caseIds);
      const nCal = Math.floor(shuffled.length * CAL_FRAC);
      const calItems = shuffled.slice(0, nCal).flatMap((c) => byCase[c]);
      const testItems = shuffled.slice(nCal).flatMap((c) => byCase[c]);
      if (!calItems.length || !testItems.length) continue;
      const { lambda } = calibrateThreshold(calItems, alpha);
      const ev = evaluate(testItems, lambda);
      risks.push(ev.realized_risk); covs.push(ev.coverage); lambdas.push(lambda);
      if (ev.supported_recall != null) recalls.push(ev.supported_recall);
      faAcc.push(ev.false_support_among_accepted);
      if (ev.realized_risk > alpha) overCount += 1;
    }
    perAlpha.push({
      alpha,
      mean_realized_risk: mean(risks),
      mean_coverage: mean(covs),
      mean_supported_recall: recalls.length ? mean(recalls) : null,
      mean_false_support_among_accepted: mean(faAcc),
      median_lambda: lambdas.sort((a, b) => a - b)[Math.floor(lambdas.length / 2)],
      frac_splits_over_alpha: overCount / SPLITS,
    });
  }

  const lines = [];
  lines.push("# Conformal Risk Control on the Support Decision -- Results");
  lines.push("");
  lines.push(`Experiment: \`${data.experiment_id}\`, model ${data.model}, ${data.cases} synthetic cases.`);
  lines.push(`Present-asserted items: ${overall.items} (${overall.supported} supported, ${overall.unsupported} unsupported by construction).`);
  lines.push("");
  lines.push(`Claim boundary: ${data.claim_boundary}`);
  lines.push("");
  lines.push("## CRC calibration (case-clustered, 200 seeded splits, 50/50)");
  lines.push("");
  lines.push("| alpha | mean realized risk | mean coverage | supported recall | false-support among accepted | median lambda | frac splits over alpha |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of perAlpha) {
    lines.push(`| ${r.alpha} | ${r.mean_realized_risk.toFixed(4)} | ${r.mean_coverage.toFixed(3)} | ${r.mean_supported_recall == null ? "n/a" : r.mean_supported_recall.toFixed(3)} | ${r.mean_false_support_among_accepted.toFixed(3)} | ${r.median_lambda.toFixed(3)} | ${r.frac_splits_over_alpha.toFixed(3)} |`);
  }
  lines.push("");
  lines.push("## False-support reasons (unsupported present-asserted items)");
  lines.push("");
  for (const [reason, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${reason}: ${n}`);
  }
  const out = lines.join("\n");
  console.log(out);
  if (OUT_MD) { fs.writeFileSync(OUT_MD, out + "\n"); console.log(`\nWrote ${OUT_MD}`); }
}

main();
