#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { generateCandidates } = require("./candidate-first-index");

function parseArgs(argv) {
  const args = {
    out: "results/benchmark-candidate-predictions.json",
    "max-total": "220",
    "max-per-domain": "80",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

function predictBenchmarkCandidates(payload, options = {}) {
  const records = Array.isArray(payload) ? payload : payload.records || payload.cases || [];
  return {
    schema_version: "handofflens-benchmark-predictions-v1",
    predictor: {
      name: "candidate-first-index",
      version: "candidate-first-index-v1",
      profile_id: options.profileId || "record-metadata-or-default",
    },
    records: records.map((record, index) => {
      const recordId = String(record.record_id || record.case_id || record.id || `record-${index + 1}`);
      const profileId = record.metadata?.profile_id || options.profileId || "clinical-dialogue";
      const indexResult = generateCandidates(record.source_text || record.src || "", {
        profileId,
        maxTotal: Number(options.maxTotal || 220),
        maxPerDomain: Number(options.maxPerDomain || 80),
      });
      return {
        record_id: recordId,
        predicted_items: indexResult.candidates.map((candidate, itemIndex) => ({
          item_id: `${recordId}:P${String(itemIndex + 1).padStart(3, "0")}`,
          domain: candidate.domain_hint,
          label: candidate.canonical_text,
          source_quote: candidate.source_quote,
          assertion_status: "unknown",
          span: { start: candidate.original_start, end: candidate.original_end },
        })),
      };
    }),
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.records) {
    console.error("--records is required");
    process.exit(1);
  }
  const predictions = predictBenchmarkCandidates(readJson(args.records), {
    profileId: args["profile-id"],
    maxTotal: Number(args["max-total"]),
    maxPerDomain: Number(args["max-per-domain"]),
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(predictions, null, 2)}\n`);
  console.log(JSON.stringify({
    records: predictions.records.length,
    predicted_items: predictions.records.reduce((sum, record) => sum + record.predicted_items.length, 0),
  }, null, 2));
}

if (require.main === module) main();
module.exports = { predictBenchmarkCandidates };