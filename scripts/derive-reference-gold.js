#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { generateCandidates } = require("./candidate-first-index");

function parseArgs(argv) {
  const args = {
    out: "results/reference-derived-gold.json",
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

function deriveReferenceGold(payload, options = {}) {
  const records = Array.isArray(payload) ? payload : payload.records || payload.cases || [];
  const cases = records.map((record, index) => {
    const recordId = String(record.record_id || record.case_id || record.id || `record-${index + 1}`);
    const profileId = record.metadata?.profile_id || options.profileId || "clinical-dialogue";
    const referenceText = String(record.reference_text || record.target_text || record.tgt || "");
    const generated = referenceText
      ? generateCandidates(referenceText, {
          profileId,
          maxTotal: Number(options.maxTotal || 220),
          maxPerDomain: Number(options.maxPerDomain || 80),
        }).candidates
      : [];
    return {
      record_id: recordId,
      source_text: record.source_text || "",
      reference_text: referenceText,
      metadata: {
        ...(record.metadata || {}),
        reference_gold_derivation: "candidate-first-index-over-reference-note-v1",
      },
      gold_items: generated.map((candidate, itemIndex) => ({
        item_id: `${recordId}:RG${String(itemIndex + 1).padStart(3, "0")}`,
        domain: candidate.domain_hint,
        label: candidate.canonical_text,
        source_quote: candidate.source_quote,
        assertion_status: "unknown",
        span: { start: candidate.original_start, end: candidate.original_end },
      })),
    };
  });
  return {
    schema_version: "handofflens-records-v1",
    derivation: {
      name: "derive-reference-gold",
      version: "candidate-first-index-over-reference-note-v1",
      caveat: "Gold items are deterministically derived from expert reference notes. This is a public reference-note alignment benchmark, not native human entity annotation.",
    },
    records: cases,
    summary: {
      records: cases.length,
      records_with_reference_text: cases.filter((record) => record.reference_text).length,
      gold_items: cases.reduce((sum, record) => sum + record.gold_items.length, 0),
    },
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
  const report = deriveReferenceGold(readJson(args.records), {
    profileId: args["profile-id"],
    maxTotal: Number(args["max-total"]),
    maxPerDomain: Number(args["max-per-domain"]),
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

if (require.main === module) main();
module.exports = { deriveReferenceGold };