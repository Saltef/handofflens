#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || path.join("eval", "dataset_sample_all.json");
const outPath = args.out || path.join("eval", "dataset_sample_representative_100.json");
const reportPath = args.report || outPath.replace(/\.json$/i, ".md");
const size = Number(args.size || 100);
const seed = Number(args.seed || 42);
const bins = Number(args.bins || 10);

const cases = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (!cases.length) throw new Error(`No cases found in ${inputPath}`);
const uniqueSubjectCount = new Set(cases.map(subjectKey)).size;
if (size > uniqueSubjectCount) throw new Error(`Requested ${size} cases from only ${uniqueSubjectCount} unique subjects`);

const selected = selectRepresentativeCases(cases, size, bins, seed);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(selected.map((item) => item.case), null, 2)}\n`);
fs.writeFileSync(reportPath, renderReport(cases, selected, size, bins));

console.log(`Read ${cases.length} cases`);
console.log(`Wrote ${selected.length} representative cases to ${outPath}`);
console.log(`Wrote report to ${reportPath}`);

function selectRepresentativeCases(cases, size, bins, seed) {
  const enriched = cases.map((item, index) => ({
    case: item,
    index,
    length: item.discharge_summary.length,
    diagnosis_family: diagnosisFamily(item.admission_diagnosis)
  })).sort((a, b) => a.length - b.length);

  const perBin = Math.floor(size / bins);
  const remainder = size % bins;
  const selected = [];
  const selectedIds = new Set();
  const selectedSubjects = new Set();

  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin * enriched.length) / bins);
    const end = Math.floor(((bin + 1) * enriched.length) / bins);
    const binItems = shuffle(enriched.slice(start, end), seed + bin);
    const target = perBin + (bin < remainder ? 1 : 0);
    const chosenFamilies = new Set();

    for (const item of binItems) {
      if (selected.length >= size) break;
      if (selectedIds.has(item.case.case_id)) continue;
      if (selectedSubjects.has(subjectKey(item.case))) continue;
      if (chosenFamilies.has(item.diagnosis_family) && chosenFamilies.size < target) continue;
      selected.push({ ...item, length_bin: bin + 1 });
      selectedIds.add(item.case.case_id);
      selectedSubjects.add(subjectKey(item.case));
      chosenFamilies.add(item.diagnosis_family);
      if (selected.filter((candidate) => candidate.length_bin === bin + 1).length === target) break;
    }

    for (const item of binItems) {
      if (selected.filter((candidate) => candidate.length_bin === bin + 1).length === target) break;
      if (selectedIds.has(item.case.case_id)) continue;
      if (selectedSubjects.has(subjectKey(item.case))) continue;
      selected.push({ ...item, length_bin: bin + 1 });
      selectedIds.add(item.case.case_id);
      selectedSubjects.add(subjectKey(item.case));
    }
  }

  return selected.sort((a, b) => a.case.case_id.localeCompare(b.case.case_id));
}

function subjectKey(item) {
  const value = String(item?.subject_id ?? "").trim();
  if (!value) throw new Error(`Case ${item?.case_id || "unknown"} is missing subject_id; patient-independent sampling is required`);
  return value;
}

function diagnosisFamily(value) {
  const text = String(value || "unknown").toLowerCase();
  if (/(cabg|coronary|cardiac|heart|valve|myocard|aortic|mitral|atrial|chf|cad)/.test(text)) return "cardiovascular";
  if (/(copd|pneumonia|respiratory|asthma|hypoxia|emphysema|lung)/.test(text)) return "respiratory";
  if (/(sepsis|infection|bacteremia|fever|cellulitis)/.test(text)) return "infection";
  if (/(gi|gastro|bleed|abdominal|bowel|liver|pancrea|chole)/.test(text)) return "gastrointestinal";
  if (/(renal|kidney|dialysis|esrd|urinary)/.test(text)) return "renal";
  if (/(stroke|seizure|hemorrhage|neuro|brain|spine|mental)/.test(text)) return "neurologic";
  if (/(fracture|joint|hip|knee|orthopedic|wound|ulcer|gangrene|amputation)/.test(text)) return "surgical_or_wound";
  if (/(cancer|mass|tumor|lymphoma|leukemia|carcinoma)/.test(text)) return "oncology";
  return "other";
}

function renderReport(allCases, selected, size, bins) {
  const allLengths = allCases.map((item) => item.discharge_summary.length).sort((a, b) => a - b);
  const sampleLengths = selected.map((item) => item.length).sort((a, b) => a - b);
  const byBin = countBy(selected.map((item) => `bin_${item.length_bin}`));
  const byFamily = countBy(selected.map((item) => item.diagnosis_family));
  const lines = [
    `# Representative ${size}-Case Sample`,
    "",
    `Source cases: ${allCases.length}`,
    `Selected cases: ${size}`,
    `Length bins: ${bins}`,
    "",
    "Selection method: deterministic patient-level stratified sampling by discharge-summary character length. At most one admission is selected per subject; the sampler selects across length deciles and prefers diverse admission-diagnosis families within each decile.",
    "",
    "## Length Distribution",
    "",
    "| Set | Min | P25 | Median | P75 | Max |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    `| Full dataset | ${min(allLengths)} | ${percentile(allLengths, 0.25)} | ${percentile(allLengths, 0.50)} | ${percentile(allLengths, 0.75)} | ${max(allLengths)} |`,
    `| Selected sample | ${min(sampleLengths)} | ${percentile(sampleLengths, 0.25)} | ${percentile(sampleLengths, 0.50)} | ${percentile(sampleLengths, 0.75)} | ${max(sampleLengths)} |`,
    "",
    "## Length Bins",
    "",
    "| Bin | Cases |",
    "| --- | ---: |"
  ];
  for (let bin = 1; bin <= bins; bin += 1) lines.push(`| ${bin} | ${byBin[`bin_${bin}`] || 0} |`);
  lines.push("", "## Diagnosis Families", "", "| Family | Cases |", "| --- | ---: |");
  for (const [family, count] of Object.entries(byFamily)) lines.push(`| ${family} | ${count} |`);
  lines.push("", "## Case IDs", "", selected.map((item) => `- ${item.case.case_id}: length ${item.length}, ${item.diagnosis_family}, ${item.case.admission_diagnosis || "unknown"}`).join("\n"), "");
  return `${lines.join("\n")}\n`;
}

function countBy(items) {
  const counts = {};
  for (const item of items) counts[item] = (counts[item] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function percentile(values, p) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];
}

function min(values) {
  return values[0] || 0;
}

function max(values) {
  return values[values.length - 1] || 0;
}

function shuffle(items, seed) {
  const shuffled = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
