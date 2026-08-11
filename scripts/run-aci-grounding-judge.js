"use strict";

// Real-data grounding pass (#1): applies the Command A+ grounding judge to real
// ACI-Bench expert notes. For each note sentence, the judge estimates whether the
// source conversation supports it as a stated/derivable fact. ACI has no
// per-sentence grounding gold, so this is a DESCRIPTIVE behavior pass (flag rate +
// examples for eyeballing), not a validated accuracy measurement.

const fs = require("node:fs");
const path = require("node:path");

// ACI-Bench data is NOT bundled in this repo (public dataset, CC BY 4.0). Point
// RECORDS at a local adapter-produced records file (see scripts/adapt-aci-bench.js
// and docs/records-adapter-contract.md). Records must have source_text +
// reference_text. Example: RECORDS=/path/to/aci-train-records.json
const RECORDS = process.env.RECORDS;
if (!RECORDS) {
  console.error("Set RECORDS=/path/to/aci-records.json (ACI-Bench data is external; see docs/records-adapter-contract.md).");
  process.exit(2);
}
const OUT = process.env.OUT_PATH || path.join("results", "aci-grounding-judge.json");
const MODEL = process.env.COHERE_MODEL || "command-a-plus-05-2026";
const LIMIT = Number(process.env.LIMIT || 25);
const THRESH = Number(process.env.THRESH || 0.5);

function sentences(note) {
  return String(note || "")
    .split(/\n+/).flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && /[a-zA-Z]/.test(s));
}

async function judge(sentence, source) {
  const apiKey = process.env.COHERE_API_KEY;
  // NB: thinking:{type:"disabled"} returns HTTP 422 (INVALID_TOOL_GENERATION) on
  // long transcripts; an enabled thinking budget with headroom is required here.
  const system = [
    "You verify clinical note grounding.",
    "Given a NOTE SENTENCE and the SOURCE conversation it should be grounded in, estimate the probability the source states or directly supports the sentence.",
    "Score high if the source contains the information (possibly paraphrased). Score low if the sentence adds facts not present in the source.",
    "Reply with ONLY a number between 0 and 1, nothing else.",
  ].join(" ");
  const user = `SOURCE conversation:\n${source}\n\nNOTE SENTENCE: "${sentence}"`;
  const body = { model: MODEL, temperature: 0, max_tokens: 800, thinking: { type: "enabled", token_budget: 512 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  const r = await fetch("https://api.cohere.com/v2/chat", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Cohere ${r.status}: ${j.error_type || ""}`);
  const text = (j.message && j.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const m = text.match(/(\d*\.?\d+)/);
  return m ? Math.max(0, Math.min(1, Number(m[1]))) : null;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(RECORDS, "utf8"));
  const recs = (Array.isArray(raw) ? raw : (raw.records || Object.values(raw))).filter((r) => r.reference_text && r.source_text).slice(0, LIMIT);
  const perSentence = [];
  let done = 0;
  for (const rec of recs) {
    for (const sent of sentences(rec.reference_text)) {
      let s = null; try { s = await judge(sent, rec.source_text); } catch (e) { console.error(e.message); }
      if (s != null) perSentence.push({ record_id: rec.record_id, sentence: sent, support: s, flagged: s < THRESH });
    }
    if (++done % 5 === 0) console.error(`...${done}/${recs.length} records`);
  }
  const flagged = perSentence.filter((p) => p.flagged);
  const payload = {
    experiment_id: "aci-grounding-judge-v1",
    model: `cohere:${MODEL}`,
    records_used: recs.length,
    sentences: perSentence.length,
    flagged_count: flagged.length,
    flagged_rate: perSentence.length ? flagged.length / perSentence.length : 0,
    threshold: THRESH,
    claim_boundary: "Descriptive verifier behavior on real ACI expert notes; no per-sentence grounding gold, so flag rate is not validated accuracy. Expert notes contain legitimate synthesis, so some flags are inference rather than error.",
    example_flagged: flagged.slice(0, 12).map((f) => ({ record_id: f.record_id, support: f.support, sentence: f.sentence })),
    records: perSentence,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`wrote ${perSentence.length} sentences, ${flagged.length} flagged (${(payload.flagged_rate * 100).toFixed(1)}%) -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
