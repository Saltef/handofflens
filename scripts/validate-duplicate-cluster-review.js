#!/usr/bin/env node

const fs = require("node:fs");
const args = parseArgs(process.argv.slice(2));
const input = args.input || "results/duplicate-cluster-review-private.csv";
const rows = parseCsv(fs.readFileSync(input, "utf8"));
const allowed = new Set(["keep_cluster", "split_cluster", "uncertain"]);
const incomplete = rows.filter((row) => !allowed.has(row.decision) || !row.reviewer || !row.reviewed_at || !row.rationale || (row.decision === "split_cluster" && !row.split_groups_if_needed));
console.log(`Reviewed=${rows.length - incomplete.length}/${rows.length}`);
for (const row of incomplete) console.log(`INCOMPLETE ${row.cluster_id}`);
if (incomplete.length) process.exitCode = 2;

function parseCsv(text) {
  const records = []; let row = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i += 1) { const c = text[i]; if (quoted && c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = !quoted; else if (c === "," && !quoted) { row.push(field); field = ""; } else if ((c === "\n" || c === "\r") && !quoted) { if (c === "\r" && text[i + 1] === "\n") i += 1; row.push(field); field = ""; if (row.some(Boolean)) records.push(row); row = []; } else field += c; }
  if (field || row.length) { row.push(field); records.push(row); }
  const [headers, ...data] = records; return data.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}
function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 1) { const item = argv[index]; if (!item.startsWith("--")) continue; const next = argv[index + 1]; if (!next || next.startsWith("--")) parsed[item.slice(2)] = true; else { parsed[item.slice(2)] = next; index += 1; } } return parsed; }
