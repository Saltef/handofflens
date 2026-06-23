#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const args = parseArgs(process.argv.slice(2));
const input = required(args.input, "--input is required");
const report = JSON.parse(fs.readFileSync(input, "utf8"));
const definitions = [
  { name: "cohere", match: /^cohere-aplus:/, out: args.cohere || "results/paired-confirmatory-cohere.json" },
  { name: "claude", match: /^anthropic\/claude-haiku-4\.5$/, out: args.claude || "results/paired-confirmatory-claude.json" }
];
for (const definition of definitions) {
  const results = (report.results || []).filter((item) => definition.match.test(String(item.model || "")));
  const caseIds = new Set(results.map((item) => item.case_id));
  if (!results.length) throw new Error(`No ${definition.name} results found`);
  if (results.length !== caseIds.size) throw new Error(`${definition.name} has duplicate case results`);
  const output = { generated_at: new Date().toISOString(), source_report: input, cases: [...caseIds], models: [...new Set(results.map((item) => item.model))], results };
  fs.mkdirSync(path.dirname(definition.out), { recursive: true }); fs.writeFileSync(definition.out, `${JSON.stringify(output, null, 2)}\n`); console.log(`Wrote ${definition.out}: ${results.length} cases`);
}
function required(value, message) { if (!value) throw new Error(message); return value; }
function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 1) { const item = argv[index]; if (!item.startsWith("--")) continue; const next = argv[index + 1]; if (!next || next.startsWith("--")) parsed[item.slice(2)] = true; else { parsed[item.slice(2)] = next; index += 1; } } return parsed; }
