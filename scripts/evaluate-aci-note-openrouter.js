#!/usr/bin/env node
"use strict";

// ACI-Bench note-generation run via an OpenRouter model, using the SAME prompt
// and the SAME scorers as evaluate-aci-note-cohere.js, so the aggregate numbers
// are directly comparable to the Command A+ run (a same-harness cross-provider
// baseline, not an official ACI leaderboard result). External ACI data is not in
// the repo; pass --input a local adapted records file.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scoreAciNoteGeneration } = require("./score-aci-note-generation");
const { scoreAciNoteFactuality } = require("./score-aci-note-factuality");

function parseArgs(argv) {
  const args = { model: "anthropic/claude-haiku-4.5", "prediction-field": "generated_note", "max-tokens": "2500", split: "combined", out: "results/aci-note-openrouter.json" };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2), n = argv[i + 1];
    if (!n || n.startsWith("--")) args[k] = true; else { args[k] = n; i += 1; }
  }
  return args;
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// EXACT prompt from evaluate-aci-note-cohere.js (buildCohereRequest).
function messagesFor(recordId, source) {
  const system = [
    "You are generating a concise clinical note from a clinician-patient dialogue for a research benchmark.",
    "Use only information explicitly supported by the dialogue.",
    "Do not invent diagnoses, medications, labs, plans, dates, or follow-up instructions.",
    "Preserve uncertainty, negation, and temporality.",
    "Return only the generated clinical note text.",
  ].join(" ");
  const user = [`Record: ${recordId}`, "", "Dialogue:", String(source || "").trim(), "", "Write the clinical note."].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

async function callOpenRouter(model, messages, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const predictionField = args["prediction-field"];
  const maxTokens = Number(args["max-tokens"]);
  const rows = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const records = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const recordId = row.record_id || row.file || `${args.split}:${i + 1}`;
    const source = row.source_text || row.src || "";
    const reference = row.reference_text || row.tgt || "";
    let generated = "";
    try { generated = await callOpenRouter(args.model, messagesFor(recordId, source), maxTokens); }
    catch (e) { console.error(`${i + 1}/${rows.length} ${recordId}: ${e.message}`); }
    records.push({
      record_id: recordId, source_text: source, reference_text: reference,
      [predictionField]: generated,
      aci_note_generation_metadata: { provider: "openrouter", model: args.model, record_id: String(recordId), split: args.split, source_sha256: sha256(source), reference_sha256: reference ? sha256(reference) : null },
    });
    if ((i + 1) % 20 === 0) console.error(`...${i + 1}/${rows.length}`);
  }
  const completed = records.filter((r) => String(r[predictionField] || "").trim());
  const rouge = scoreAciNoteGeneration(completed, { split: args.split, predictionField, bootstrapRepeats: 1000 });
  const factuality = scoreAciNoteFactuality(completed, { split: args.split, predictionField });
  const report = {
    generated_at: new Date().toISOString(), schema_version: "aci-note-openrouter-eval-v1",
    provider: "openrouter", model: args.model, split: args.split, prediction_field: predictionField,
    summary: { rows_requested: rows.length, completed_rows: completed.length, failed_rows: records.length - completed.length, rouge: rouge.summary, source_support: factuality.summary },
    records,
    interpretation: "OpenRouter ACI note-generation run under the identical HandoffLens prompt and scorers as the Command A+ run. Same-harness cross-provider baseline, not an official ACI leaderboard result.",
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote ${completed.length}/${rows.length} completed -> ${args.out}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
