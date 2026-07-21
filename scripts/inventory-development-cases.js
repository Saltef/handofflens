#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const args = parseArgs(process.argv.slice(2));
const corpusPath = args.corpus || "eval/dataset_sample_all.json";
const scanRoots = String(args.scan || "results").split(",").map((item) => item.trim()).filter(Boolean);
const outPath = args.out || "results/development-case-inventory-private.json";
const mdPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const exclusionPath = args.exclusion || "eval/direct_development_cases_private.json";
const processedPath = args.processed || "eval/all_processed_cases_private.json";
const candidatePath = args.candidates || "eval/internal_validation_candidates_private.json";
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const byId = new Map(corpus.map((item) => [String(item.case_id), item]));
const evidence = new Map();
const directEvidence = new Map();
const categoryIds = new Map();
const humanReviewerIds = new Set();
const llmReviewerIds = new Set();
const files = scanRoots.flatMap(walkJsonFiles).filter((file) => !samePath(file, outPath));
const failures = [];

for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push({ file: relative(file), error: error.message });
    continue;
  }
  const ids = new Set();
  collectCaseIds(parsed, ids);
  const category = classifyFile(relative(file));
  const exposure = category === "bulk_extraction_only" ? category : "direct_or_proxy_development";
  if (!categoryIds.has(category)) categoryIds.set(category, new Set());
  for (const id of ids) if (byId.has(id)) categoryIds.get(category).add(id);
  collectReviewerIds(parsed, humanReviewerIds, llmReviewerIds);
  for (const id of ids) {
    if (!byId.has(id)) continue;
    if (!evidence.has(id)) evidence.set(id, []);
    evidence.get(id).push(relative(file));
    if (exposure === "direct_or_proxy_development") {
      if (!directEvidence.has(id)) directEvidence.set(id, []);
      directEvidence.get(id).push(relative(file));
    }
  }
}

const exposed = corpus.filter((item) => evidence.has(String(item.case_id)));
const direct = corpus.filter((item) => directEvidence.has(String(item.case_id)));
const bulkOnly = corpus.filter((item) => evidence.has(String(item.case_id)) && !directEvidence.has(String(item.case_id)));
const untouched = corpus.filter((item) => !evidence.has(String(item.case_id)));
const report = {
  generated_at: new Date().toISOString(),
  rule: "Tiered: case-level review/judge/routing/failure/comparison artifacts are direct/proxy development; cases present only in bulk extraction artifacts retain unseen clinician endpoints.",
  corpus_path: corpusPath,
  corpus_hash: sha256(fs.readFileSync(corpusPath)),
  scanned_roots: scanRoots,
  scanned_json_files: files.length,
  parse_failures: failures,
  corpus_cases: corpus.length,
  development_exposed_cases: exposed.length,
  direct_or_proxy_development_cases: direct.length,
  bulk_extraction_only_cases: bulkOnly.length,
  untouched_cases: untouched.length,
  external_confirmatory_eligible_from_current_corpus: false,
  locked_internal_validation_candidates: bulkOnly.length,
  evidence_category_case_counts: Object.fromEntries([...categoryIds.entries()].map(([key, ids]) => [key, ids.size])),
  completed_human_review_artifact_found: humanReviewerIds.size > 0,
  human_reviewer_ids: [...humanReviewerIds].sort(),
  llm_reviewer_ids: [...llmReviewerIds].sort(),
  conclusion: bulkOnly.length ?
    "Bulk-only cases retain unseen clinician endpoints and may support locked internal validation after human confirmation that outputs were not individually inspected. This is not external or temporal validation." :
    "No bulk-only cases remain; the corpus supports development/descriptive analysis only.",
  cases: exposed.map((item) => ({
    case_id: item.case_id,
    subject_hash: sha256(`subject:${item.subject_id}`),
    evidence_files: evidence.get(String(item.case_id)).sort()
  })),
  untouched_case_ids: untouched.map((item) => item.case_id)
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.mkdirSync(path.dirname(exclusionPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(exclusionPath, `${JSON.stringify(direct, null, 2)}\n`);
fs.writeFileSync(processedPath, `${JSON.stringify(exposed, null, 2)}\n`);
fs.writeFileSync(candidatePath, `${JSON.stringify(bulkOnly, null, 2)}\n`);
fs.writeFileSync(mdPath, renderMarkdown(report));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdPath}`);
console.log(`Wrote exclusion cohort ${exclusionPath}`);
console.log(`Wrote all-processed ledger ${processedPath}`);
console.log(`Wrote internal-validation candidates ${candidatePath}`);
console.log(`Direct/proxy=${direct.length}; bulk-only=${bulkOnly.length}; untouched=${untouched.length}`);

function classifyFile(file) {
  const normalized = file.toLowerCase();
  if (/judge/.test(normalized)) return "llm_judge";
  if (/review/.test(normalized)) return "prepared_review_or_review_subset";
  if (/routing|conformal|hybrid|feature-predict|similarity-predict/.test(normalized)) return "routing_or_proxy_analysis";
  if (/failure/.test(normalized)) return "failure_analysis";
  if (/comparison|smoke|variant|case\d+|case_?0*\d+|clean25|parser25|representative100|representative300|representative500|three-model|qwen|opus|sonnet/.test(normalized)) return "model_or_configuration_development";
  return "bulk_extraction_only";
}

function collectReviewerIds(value, human, llm, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (typeof value.reviewer_id === "string" && value.reviewer_id.trim()) {
    const id = value.reviewer_id.trim();
    if (/^LLM_JUDGE:/i.test(id)) llm.add(id); else human.add(id);
  }
  for (const child of Object.values(value)) collectReviewerIds(child, human, llm, seen);
}

function collectCaseIds(value, output, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (typeof value.case_id === "string") output.add(value.case_id);
  if (Array.isArray(value.cases) && value.cases.every((item) => typeof item === "string")) {
    for (const id of value.cases) output.add(id);
  }
  for (const child of Object.values(value)) collectCaseIds(child, output, seen);
}

function walkJsonFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return root.toLowerCase().endsWith(".json") ? [root] : [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkJsonFiles(file) : entry.name.toLowerCase().endsWith(".json") ? [file] : [];
  });
}

function renderMarkdown(report) {
  const categories = Object.entries(report.evidence_category_case_counts).map(([key, value]) => `- ${key}: ${value}`).join("\n");
  return `# Development Case Inventory\n\nGenerated: ${report.generated_at}\n\n- Corpus cases: ${report.corpus_cases}\n- Scanned JSON artifacts: ${report.scanned_json_files}\n- Direct/proxy development cases: ${report.direct_or_proxy_development_cases}\n- Bulk-extraction-only cases: ${report.bulk_extraction_only_cases}\n- Never processed: ${report.untouched_cases}\n- Completed human-review artifact found: ${report.completed_human_review_artifact_found}\n- LLM reviewer IDs: ${report.llm_reviewer_ids.join(", ") || "none"}\n- Parse failures: ${report.parse_failures.length}\n\n## Evidence categories\n\n${categories}\n\n## Conclusion\n\n${report.conclusion}\n\n## Classification rule\n\n${report.rule}\n\nBulk-only eligibility requires confirmation that case-level outputs were not individually inspected. Prepared blank review packets do not count as completed human review. LLM-judge labels are proxy development outcomes, not clinician endpoints.\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function relative(file) {
  return path.relative(process.cwd(), path.resolve(file)).replaceAll("\\", "/");
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[item.slice(2)] = true;
    else { parsed[item.slice(2)] = next; index += 1; }
  }
  return parsed;
}
