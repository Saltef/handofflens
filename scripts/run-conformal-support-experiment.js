"use strict";

// Live runner for the conformal-support experiment. Extracts present clinical
// facts from synthetic construction-true cases, computes a model-derived lexical
// support score per item, and assigns the construction-true supported label from
// gold. Emits per-item records for conformal risk control (see
// scripts/conformal-risk-control.js). Cohere only in this first pass.

const fs = require("node:fs");
const path = require("node:path");

const CASES_PATH = process.env.CASES_PATH || path.join("eval", "synthetic_gold_cases.json");
const OUT_PATH = process.env.OUT_PATH || path.join("results", "conformal-support-items.json");
const MODEL = process.env.COHERE_MODEL || "command-a-plus-05-2026";

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s./]/g, " ").replace(/\s+/g, " ").trim(); }
function tokens(s) { return norm(s).split(" ").filter(Boolean); }
function coverage(valueTokens, quoteTokens) {
  if (!valueTokens.length) return 0;
  const q = new Set(quoteTokens);
  return valueTokens.filter((t) => q.has(t)).length / valueTokens.length;
}
function bestSentence(quote, sentences) {
  const qt = new Set(tokens(quote));
  let best = null, bestOverlap = -1;
  for (const s of sentences) {
    const st = tokens(s);
    const ov = st.length ? st.filter((t) => qt.has(t)).length / st.length : 0;
    if (ov > bestOverlap) { bestOverlap = ov; best = s; }
  }
  return { sentence: best, overlap: bestOverlap };
}

function labelItem(item, testCase) {
  const value = item.normalized_value || "";
  const quote = item.source_quote || "";
  const vTok = tokens(value);
  const score = coverage(vTok, tokens(quote)); // model-derived lexical support
  const presentSentences = testCase.gold.map((g) => g.gold_sentence);
  const distractorByText = new Map(testCase.distractors.map((d) => [norm(d.text), d.kind]));

  // Which source sentence did the model ground on?
  const allSentences = testCase.discharge_summary.split("\n");
  const { sentence: matched } = bestSentence(quote || value, allSentences);
  const matchedNorm = norm(matched);

  const isPresentSentence = presentSentences.some((s) => norm(s) === matchedNorm);
  const valueInMatched = vTok.length && tokens(matched).length
    ? vTok.filter((t) => new Set(tokens(matched)).has(t)).length / vTok.length >= 0.8
    : false;

  let supported, reason;
  if (isPresentSentence && valueInMatched) {
    supported = true; reason = "present_grounded";
  } else if (distractorByText.has(matchedNorm)) {
    supported = false; reason = `distractor_${distractorByText.get(matchedNorm)}`;
  } else if (!valueInMatched) {
    supported = false; reason = "value_not_grounded";
  } else {
    supported = false; reason = "non_gold_sentence";
  }
  return { score, supported, reason, assertion: item.assertion || "present", value };
}

async function callCohere(testCase) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");
  const system = [
    "You extract PRESENT clinical facts from a discharge summary for an auditability experiment.",
    "Return only JSON: { \"items\": [ { \"field\": string, \"normalized_value\": string, \"assertion\": one of present|absent|historical|conditional, \"source_quote\": string } ] }.",
    "Extract medications started, labs, and follow-ups. Copy source_quote verbatim from the summary.",
    "Use assertion=absent for negated statements, historical for prior/discontinued, conditional for if/then. Only assertion=present items are treated as current facts.",
    "Do not invent facts. Prefer omission over guessing.",
  ].join(" ");
  const body = {
    model: MODEL,
    temperature: 0,
    max_tokens: 3000,
    thinking: { token_budget: 512 },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Discharge summary:\n${testCase.discharge_summary}` },
    ],
  };
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Cohere ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const text = (j.message && j.message.content || []).map((c) => c.text || "").join("");
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { items: [] }; }
  return Array.isArray(parsed.items) ? parsed.items : [];
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const records = [];
  let done = 0;
  for (const testCase of cases) {
    let items = [];
    try { items = await callCohere(testCase); }
    catch (e) { console.error(`case ${testCase.case_id} error: ${e.message}`); }
    for (const item of items) {
      const labeled = labelItem(item, testCase);
      // CRC target: items the model asserts present (candidates for auto-accept).
      if (labeled.assertion === "present") {
        records.push({ case_id: testCase.case_id, ...labeled });
      }
    }
    done += 1;
    if (done % 10 === 0) console.error(`...${done}/${cases.length} cases`);
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const payload = {
    experiment_id: "conformal-support-v1",
    model: `cohere:${MODEL}`,
    cases: cases.length,
    present_asserted_items: records.length,
    supported_items: records.filter((r) => r.supported).length,
    claim_boundary: "Synthetic construction-true labels only. Real coverage of a synthetic distribution; not real clinical notes, adjudicated gold, or population performance.",
    records,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`wrote ${records.length} present-asserted items (${payload.supported_items} supported) -> ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
