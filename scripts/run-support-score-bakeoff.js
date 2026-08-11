"use strict";

// Support-score bake-off under a shared CRC harness. Builds construction-true
// (value, quote, label) pairs from synthetic gold cases, scores each pair with
// every candidate score, and calibrates conformal risk control per score. The
// winner accepts the most items (highest coverage) while holding realized
// false-support risk <= alpha. An optional entailment score is read from an
// augmented pool if present (field `entailment` on each pair).

const fs = require("node:fs");
const path = require("node:path");
const { calibrateThreshold, evaluate } = require("./conformal-risk-control");
const scores = require("./support-scores");

const CASES_PATH = process.argv[2] || path.join("eval", "synthetic_gold_cases.json");
const AUG_PATH = process.argv[3] || null; // optional pool with entailment scores
const OUT_MD = process.argv[4] || null;
const ALPHAS = [0.05, 0.1, 0.2];
const SPLITS = 200;

let _s = 0x51ed270b;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

function buildPairs(cases) {
  const pairs = [];
  for (const c of cases) {
    for (const g of c.gold) pairs.push({ case_id: c.case_id, value: g.normalized_value, quote: g.gold_sentence, supported: true, kind: "present" });
    for (const d of c.distractors) pairs.push({ case_id: c.case_id, value: d.value, quote: d.text, supported: false, kind: d.kind });
  }
  return pairs;
}

function crcByCase(pairs, scoreKey, alpha) {
  const byCase = {}; for (const p of pairs) (byCase[p.case_id] ||= []).push(p);
  const caseIds = Object.keys(byCase);
  const covs = [], risks = [];
  for (let s = 0; s < SPLITS; s++) {
    const sh = shuffle(caseIds); const nCal = Math.floor(sh.length / 2);
    const cal = sh.slice(0, nCal).flatMap((c) => byCase[c]).map((p) => ({ score: p[scoreKey], supported: p.supported }));
    const test = sh.slice(nCal).flatMap((c) => byCase[c]).map((p) => ({ score: p[scoreKey], supported: p.supported }));
    if (!cal.length || !test.length) continue;
    const { lambda } = calibrateThreshold(cal, alpha);
    const ev = evaluate(test, lambda);
    covs.push(ev.coverage); risks.push(ev.realized_risk);
  }
  return { coverage: mean(covs), realized_risk: mean(risks) };
}

function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  let pairs = buildPairs(cases);
  // Attach deterministic scores.
  for (const p of pairs) { p.lexical = scores.lexical(p.value, p.quote); p.cue_aware = scores.cueAware(p.value, p.quote); }
  // Merge entailment scores if an augmented pool is provided.
  const scoreKeys = ["lexical", "cue_aware"];
  if (AUG_PATH && fs.existsSync(AUG_PATH)) {
    const aug = JSON.parse(fs.readFileSync(AUG_PATH, "utf8"));
    const key = (p) => `${p.case_id}||${p.value}||${p.quote}`;
    const m = new Map(aug.records.map((r) => [key(r), r.entailment]));
    let matched = 0;
    for (const p of pairs) { const e = m.get(key(p)); if (e != null) { p.entailment = e; matched += 1; } }
    if (matched === pairs.length) scoreKeys.push("entailment");
    else console.error(`entailment merge incomplete (${matched}/${pairs.length}); skipping entailment arm`);
  }

  const supported = pairs.filter((p) => p.supported).length;
  const lines = [];
  lines.push("# Support-Score Bake-off Under Conformal Risk Control");
  lines.push("");
  lines.push(`Pairs: ${pairs.length} (${supported} supported, ${pairs.length - supported} unsupported by construction).`);
  lines.push(`Scores compared: ${scoreKeys.join(", ")}. Case-clustered CRC, ${SPLITS} splits.`);
  lines.push("Winner at each alpha = highest coverage while realized risk <= alpha.");
  lines.push("");
  lines.push("| alpha | score | mean coverage | mean realized risk |");
  lines.push("| ---: | --- | ---: | ---: |");
  for (const alpha of ALPHAS) {
    const rows = scoreKeys.map((k) => ({ k, ...crcByCase(pairs, k, alpha) }));
    const best = rows.reduce((a, b) => (b.coverage > a.coverage ? b : a));
    for (const r of rows) {
      lines.push(`| ${alpha} | ${r.k}${r.k === best.k ? " **(win)**" : ""} | ${r.coverage.toFixed(3)} | ${r.realized_risk.toFixed(4)} |`);
    }
  }
  // Per-kind: how each score scores each distractor kind (mean), to show WHERE
  // lexical and cue-aware fail.
  lines.push("");
  lines.push("## Mean score by item kind (higher = looks more supported)");
  lines.push("");
  const kinds = [...new Set(pairs.map((p) => p.kind))];
  lines.push(`| kind | n | ${scoreKeys.join(" | ")} |`);
  lines.push(`| --- | ---: | ${scoreKeys.map(() => "---:").join(" | ")} |`);
  for (const kind of kinds) {
    const kp = pairs.filter((p) => p.kind === kind);
    lines.push(`| ${kind} | ${kp.length} | ${scoreKeys.map((k) => mean(kp.map((p) => p[k])).toFixed(3)).join(" | ")} |`);
  }
  const out = lines.join("\n");
  console.log(out);
  if (OUT_MD) { fs.writeFileSync(OUT_MD, out + "\n"); console.log(`\nWrote ${OUT_MD}`); }
}

main();
