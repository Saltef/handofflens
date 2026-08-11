"use strict";

// Deterministic synthetic discharge-summary generator with CONSTRUCTION-TRUE
// gold. Self-contained: no external data, no external-product dependency, no
// model calls. Every planted fact's value appears verbatim in exactly one sentence
// (its gold span), so the supported/unsupported label is known by construction.
//
// Each case also plants DISTRACTORS: the same field/value framed as negated,
// historical, or conditional. Those must NOT be extracted as present-supported;
// they exist so the support decision is non-trivial and so a purely lexical
// support score (which sees the value in the text) cannot trivially separate
// true present facts from wrong-assertion ones.
//
// Output shape matches eval/pilot_reference_cases.json: { case_id,
// discharge_summary, gold: [{ field, normalized_value, assertion, gold_sentence }] }.

const fs = require("node:fs");
const path = require("node:path");

// Small deterministic pools. Values are distinctive so gold matching is exact.
const MEDS = [
  ["metoprolol", "25 mg BID"], ["furosemide", "40 mg daily"], ["lisinopril", "10 mg daily"],
  ["apixaban", "5 mg BID"], ["atorvastatin", "80 mg nightly"], ["insulin glargine", "18 units nightly"],
  ["amoxicillin", "500 mg TID"], ["pantoprazole", "40 mg daily"], ["spironolactone", "25 mg daily"],
  ["clopidogrel", "75 mg daily"],
];
const LABS = [
  ["potassium", "3.2 mmol/L"], ["creatinine", "1.8 mg/dL"], ["hemoglobin", "9.4 g/dL"],
  ["troponin", "0.08 ng/mL"], ["INR", "2.6"], ["glucose", "212 mg/dL"], ["sodium", "129 mmol/L"],
];
const FOLLOWUPS = [
  ["cardiology", "in 2 weeks"], ["nephrology", "in 10 days"], ["primary care", "in 7 days"],
  ["anticoagulation clinic", "in 3 days"], ["wound care", "in 5 days"],
];

// Deterministic index-based picker (no RNG; seed derives from case index).
function pick(pool, seed) { return pool[seed % pool.length]; }

function buildCase(caseIndex) {
  const sentences = [];
  const gold = [];
  const push = (text) => { sentences.push(text); return sentences.length - 1; };

  push("SYNTHETIC TRAINING EXAMPLE — NOT A PATIENT RECORD.");
  push("HOSPITAL COURSE:");

  // Present facts (supported gold). Values appear verbatim in their sentence.
  const nMeds = 2 + (caseIndex % 3); // 2..4
  for (let i = 0; i < nMeds; i++) {
    const [drug, dose] = pick(MEDS, caseIndex * 7 + i * 3);
    const s = `Started ${drug} ${dose} for ongoing management.`;
    push(s);
    gold.push({ field: "medication", normalized_value: `${drug} ${dose}`, assertion: "present", gold_sentence: s });
  }
  const [lab, val] = pick(LABS, caseIndex * 5 + 1);
  {
    const s = `Admission ${lab} was ${val}, monitored during the stay.`;
    push(s);
    gold.push({ field: "lab", normalized_value: `${lab} ${val}`, assertion: "present", gold_sentence: s });
  }
  const [svc, when] = pick(FOLLOWUPS, caseIndex * 3 + 2);
  {
    const s = `Follow up with ${svc} ${when}.`;
    push(s);
    gold.push({ field: "followup", normalized_value: `${svc} ${when}`, assertion: "present", gold_sentence: s });
  }

  // Distractors (NOT present-supported): value appears but framed away.
  const distractors = [];
  const [dDrug, dDose] = pick(MEDS, caseIndex * 11 + 4);
  { const s = `The patient was NOT started on ${dDrug} ${dDose} due to intolerance.`; push(s); distractors.push({ kind: "negated", value: `${dDrug} ${dDose}`, text: s }); }
  const [hDrug, hDose] = pick(MEDS, caseIndex * 13 + 6);
  { const s = `History of ${hDrug} ${hDose} use prior to admission, since discontinued.`; push(s); distractors.push({ kind: "historical", value: `${hDrug} ${hDose}`, text: s }); }
  const [cLab, cVal] = pick(LABS, caseIndex * 17 + 3);
  { const s = `If ${cLab} falls below ${cVal}, replete and recheck.`; push(s); distractors.push({ kind: "conditional", value: `${cLab} ${cVal}`, text: s }); }

  // Subtle distractors: value present, NOT a current fact, but phrased WITHOUT
  // template negation/history cue words — so a cue-matching score misses them
  // and only semantic entailment should catch them.
  const [sDrug, sDose] = pick(MEDS, caseIndex * 19 + 8);
  { const s = `Held ${sDrug} ${sDose} pending specialist input.`; push(s); distractors.push({ kind: "subtle_held", value: `${sDrug} ${sDose}`, text: s, subtle: true }); }
  const [s2Drug, s2Dose] = pick(MEDS, caseIndex * 23 + 5);
  { const s = `The ${s2Drug} ${s2Dose} course finished two weeks before this stay.`; push(s); distractors.push({ kind: "subtle_completed", value: `${s2Drug} ${s2Dose}`, text: s, subtle: true }); }

  push("DISCHARGE CONDITION: stable.");

  return {
    case_id: `SYNTH_GOLD_${String(caseIndex + 1).padStart(4, "0")}`,
    subject_id: `SYNTH_SUBJECT_${String(caseIndex + 1).padStart(4, "0")}`,
    synthetic: "true",
    reference_note: "Fully synthetic construction-true fixture for conformal calibration; not a patient record and not clinically adjudicated.",
    discharge_summary: sentences.join("\n"),
    gold,
    distractors,
  };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }));
  const count = Number(args.count || 60);
  const outPath = args.out || path.join("eval", "synthetic_gold_cases.json");
  const cases = Array.from({ length: count }, (_, i) => buildCase(i));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`);
  const items = cases.reduce((a, c) => a + c.gold.length, 0);
  console.log(`Wrote ${cases.length} cases, ${items} present-gold items, ${cases.length * 3} distractors -> ${outPath}`);
  if (args.sample) console.log("\nSample case:\n", JSON.stringify(cases[0], null, 2));
}

if (require.main === module) main();
module.exports = { buildCase };
