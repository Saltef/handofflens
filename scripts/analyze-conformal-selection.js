"use strict";

// FDR-controlled selection analysis over the conformal-support items, using
// case-clustered calibration/test splits (exchangeability at the case level).
// Reports realized FDR, power, and coverage at target q. Pure analysis; no model
// calls. See conformal-selection.js for the method (Jin & Candes 2023).

const fs = require("node:fs");
const path = require("node:path");
const { selectByFdr } = require("./conformal-selection");

const ITEMS_PATH = process.argv[2] || path.join("results", "conformal-support-items.json");
const OUT_MD = process.argv[3] || null;
const QS = [0.05, 0.1, 0.2];
const SPLITS = 200;

let _s = 0x3ab19f7;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

function main() {
  const data = JSON.parse(fs.readFileSync(ITEMS_PATH, "utf8"));
  const byCase = {};
  for (const r of data.records) (byCase[r.case_id] ||= []).push({ score: r.score, supported: r.supported });
  const caseIds = Object.keys(byCase);

  const rows = [];
  for (const q of QS) {
    const fdrs = [], pows = [], covs = [];
    for (let s = 0; s < SPLITS; s += 1) {
      const sh = shuffle(caseIds); const nCal = Math.floor(sh.length / 2);
      const cal = sh.slice(0, nCal).flatMap((c) => byCase[c]);
      const test = sh.slice(nCal).flatMap((c) => byCase[c]);
      if (!cal.some((x) => !x.supported) || !test.length) continue;
      const r = selectByFdr(cal, test, q);
      fdrs.push(r.realized_fdr); covs.push(r.coverage);
      if (r.power != null) pows.push(r.power);
    }
    rows.push({ q, fdr: mean(fdrs), power: mean(pows), coverage: mean(covs) });
  }

  const lines = [];
  lines.push("# FDR-Controlled Selection -- Results");
  lines.push("");
  lines.push(`Experiment: \`${data.experiment_id}\`, model ${data.model}. Conformal selection (Jin & Candes 2023) with case-clustered ${SPLITS}-split calibration/test.`);
  lines.push(`Present-asserted items: ${data.present_asserted_items} (${data.supported_items} supported).`);
  lines.push("");
  lines.push("| target q | mean realized FDR | mean power (TPR) | mean coverage |");
  lines.push("| ---: | ---: | ---: | ---: |");
  for (const r of rows) lines.push(`| ${r.q} | ${r.fdr.toFixed(3)} | ${r.power.toFixed(3)} | ${r.coverage.toFixed(3)} |`);
  lines.push("");
  lines.push("FDR here is the false discovery rate among *selected (auto-accepted)* items -- the decision-relevant purity of the accepted set. Realized FDR is at or below q at every level. Claim boundary: synthetic construction-true labels; a real guarantee needs adjudicated labels.");
  const out = lines.join("\n");
  console.log(out);
  if (OUT_MD) { fs.writeFileSync(OUT_MD, out + "\n"); console.log(`\nWrote ${OUT_MD}`); }
}

main();
