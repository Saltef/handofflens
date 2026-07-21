#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || "clinical_cases.csv.gz";
const outPath = args.out || path.join("eval", "dataset_sample_20.json");
const limit = args.limit === "all" ? Infinity : Number(args.limit || 20);
const seed = Number(args.seed || 42);
const strategy = args.strategy || "even";

if (!fs.existsSync(inputPath)) {
  throw new Error(`Missing dataset file: ${inputPath}`);
}

const text = zlib.gunzipSync(fs.readFileSync(inputPath)).toString("utf8");
const rows = parseCsv(text);
const [header, ...records] = rows;
const cases = records.map((row, index) => rowToCase(header, row, index)).filter((item) => item.discharge_summary);
const selected = selectCases(cases, limit, strategy, seed);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(selected, null, 2)}\n`);

console.log(`Read ${cases.length} dataset cases`);
console.log(`Wrote ${selected.length} cases to ${outPath}`);
console.log("These cases are unlabeled: use them for feasibility/schema/latency runs, not F1.");

function rowToCase(header, row, index) {
  const value = Object.fromEntries(header.map((key, keyIndex) => [key, row[keyIndex] || ""]));
  return {
    case_id: value.case_id || `CASE_${String(index + 1).padStart(5, "0")}`,
    subject_id: value.subject_id,
    hadm_id: value.hadm_id,
    age: value.age,
    gender: value.gender,
    admission_diagnosis: value.admission_diagnosis,
    discharge_summary: value.discharge_summary
  };
}

function selectCases(cases, limit, strategy, seed) {
  if (!Number.isFinite(limit) || limit >= cases.length) return cases;
  if (strategy === "first") return cases.slice(0, limit);
  if (strategy === "random") return shuffle(cases, seed).slice(0, limit);

  const selected = [];
  const step = cases.length / limit;
  for (let index = 0; index < limit; index += 1) {
    selected.push(cases[Math.floor(index * step)]);
  }
  return selected;
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.length > 1);
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
