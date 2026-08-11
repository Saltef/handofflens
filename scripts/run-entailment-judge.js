"use strict";

// Entailment nonconformity score for the bake-off. For each (value, quote) pair,
// an LLM judge estimates the probability that the quote asserts the value as a
// CURRENT, ACTIVE fact for this patient at discharge. The judge never sees the
// construction-true label. Output: augmented pool with an `entailment` score in
// [0,1] per pair, consumed by run-support-score-bakeoff.js.

const fs = require("node:fs");
const path = require("node:path");

const CASES_PATH = process.env.CASES_PATH || path.join("eval", "synthetic_gold_cases.json");
const OUT_PATH = process.env.OUT_PATH || path.join("results", "bakeoff-entailment-pool.json");
const MODEL = process.env.COHERE_MODEL || "command-a-plus-05-2026";

function buildPairs(cases) {
  const pairs = [];
  for (const c of cases) {
    for (const g of c.gold) pairs.push({ case_id: c.case_id, value: g.normalized_value, quote: g.gold_sentence });
    for (const d of c.distractors) pairs.push({ case_id: c.case_id, value: d.value, quote: d.text });
  }
  return pairs;
}

// v2: task-aligned definition + calibration examples. "Supported" means the
// evidence AFFIRMS the fact as a real, applicable item for THIS admission
// (started / given / measured / planned), not "current active fact". Negated,
// conditional, held/paused, and discontinued/completed-in-past framings score
// low. Examples are definitional (they specify the task), reported transparently.
function judgeMessages(pair) {
  const system = [
    "You judge whether an evidence sentence AFFIRMS a candidate clinical fact as a real, applicable item for THIS admission — something a clinician would extract for the handoff.",
    "Score HIGH when the sentence states the fact as started, given, measured, ordered, or planned as follow-up.",
    "Score LOW when the fact is negated (not started), hypothetical or conditional (if/should), held or paused, or discontinued/completed in the past.",
    "Judge the framing, not mere word overlap: the value can appear verbatim and still be unsupported.",
    "Return only JSON: { \"support\": <number 0..1> }.",
  ].join(" ");
  // Calibration examples use DIFFERENT surface phrasings than the evaluation
  // cases, so a correct verdict reflects generalizing the definition rather than
  // matching a memorized template.
  const shots = [
    ["warfarin 3 mg daily", "Patient was initiated on warfarin 3 mg daily with INR monitoring.", 1],
    ["peak troponin 2.1 ng/mL", "Peak troponin during this admission reached 2.1 ng/mL.", 1],
    ["carvedilol 6.25 mg BID", "We elected to avoid carvedilol 6.25 mg BID given symptomatic bradycardia.", 0],
    ["metformin 1000 mg BID", "Home metformin 1000 mg BID was suspended for the duration of the stay.", 0],
    ["vancomycin IV", "Completed a course of vancomycin IV at an outside facility last month.", 0],
  ];
  const messages = [{ role: "system", content: system }];
  for (const [v, q, s] of shots) {
    messages.push({ role: "user", content: `Candidate fact: ${v}\nEvidence sentence: "${q}"` });
    messages.push({ role: "assistant", content: `{"support":${s}}` });
  }
  messages.push({ role: "user", content: `Candidate fact: ${pair.value}\nEvidence sentence: "${pair.quote}"` });
  return messages;
}

async function judge(pair) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error("Missing COHERE_API_KEY");
  const body = {
    model: MODEL, temperature: 0, max_tokens: 200,
    thinking: { type: "disabled" }, // judge must emit JSON, not burn tokens thinking
    response_format: { type: "json_object" },
    messages: judgeMessages(pair),
  };
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Cohere ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const text = (j.message && j.message.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
  let s = 0; try { const p = JSON.parse(text); s = Math.max(0, Math.min(1, Number(p.support))); } catch { s = 0; }
  return s;
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const pairs = buildPairs(cases);
  const records = [];
  let done = 0;
  for (const p of pairs) {
    let entailment = 0;
    try { entailment = await judge(p); } catch (e) { console.error(`pair error: ${e.message}`); }
    records.push({ ...p, entailment });
    if (++done % 50 === 0) console.error(`...${done}/${pairs.length} pairs`);
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify({ experiment_id: "bakeoff-entailment-v1", model: `cohere:${MODEL}`, pairs: records.length, records }, null, 2)}\n`);
  console.error(`wrote ${records.length} entailment scores -> ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
