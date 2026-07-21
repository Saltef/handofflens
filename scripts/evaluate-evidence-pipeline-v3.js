#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { indexSource, renderIndexedSource, materializeExtractionWithAudit } = require("./source-evidence-index");
const { detectClinicalSignals, compareSignalsToExtraction, validateEvidenceSemantics } = require("./clinical-validation-signals");
const { evaluateExtraction } = require("./extraction-quality-gate");
const { toProviderCompatibleSchema } = require("./schema-utils");

loadEnvFile(".env");
const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outDir = args["out-dir"] || "results/evidence-pipeline-v3-dev10";
const start = Number(args.start || 0), limit = Number(args.limit || 10);
const dryRun = Boolean(args["dry-run"]), force = Boolean(args.force);
const runAgreement = args.agreement !== "false", runVerifier = args.verifier !== "false";
const model = args.model || "command-a-plus-05-2026";
const sourceTransform = args["source-transform"] || "none";
const schema = JSON.parse(fs.readFileSync("eval/schema_evidence_pointer_stage_v3.json", "utf8"));
const providerSchema = toProviderCompatibleSchema(schema);
const prompt = fs.readFileSync("prompts/clinical-extraction-stage-v3.md", "utf8");
const systemPrompt = fs.readFileSync("prompts/system.md", "utf8");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
if (!Number.isInteger(start) || !Number.isInteger(limit) || start < 0 || start + limit > cases.length) throw new Error("Invalid range");
if (!dryRun && !process.env.COHERE_API_KEY) throw new Error("Missing COHERE_API_KEY");
fs.mkdirSync(outDir, { recursive: true });

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  const manifest = { experiment_id: "evidence-pipeline-v3-development", created_at: new Date().toISOString(), cases_path: casesPath, cases_sha256: sha256(fs.readFileSync(casesPath)), range: { start, limit }, model, reasoning: { hidden: true, token_budget: 512, chain_of_thought_stored: false }, stages: ["section_signals", "primary_extraction", "deterministic_span_validation", "selective_recovery", "independent_extraction", "semantic_verification", "evidence_only_summary", "final_gate"], source_transform: sourceTransform, retries: { provider: 0, hidden: 0, recovery: 1 }, claims_boundary: "Development-only automated evaluation; no clinical correctness or safety claim." };
  writeJson(path.join(outDir, "manifest.json"), manifest);
  const records = [];
  for (const testCase of cases.slice(start, start + limit)) {
    const file = path.join(outDir, `${safeName(testCase.case_id)}.json`);
    if (!force && fs.existsSync(file)) { records.push(JSON.parse(fs.readFileSync(file, "utf8"))); continue; }
    const source = transformSource(testCase.discharge_summary, sourceTransform);
    const index = indexSource(source), signals = detectClinicalSignals(source);
    if (dryRun) { const record = { case_id: testCase.case_id, dry_run: true, source_sha256: sha256(source), line_count: index.segments.length, signals }; writeJson(file, record); records.push(record); continue; }
    const record = await runCase(testCase, source, index, signals);
    writeJson(file, record); records.push(record);
    console.log(`${testCase.case_id}: ${record.final_gate?.valid ? "PASS" : record.failure_stage || "FAIL"}`);
  }
  const summary = summarize(records);
  writeJson(path.join(outDir, "combined.json"), { manifest, summary, records });
  console.log(JSON.stringify(summary, null, 2));
}

async function runCase(testCase, source, index, signals) {
  const startedAt = Date.now(), calls = [], stageErrors = [];
  let primary, primaryMaterialized, spanAudit = [], weakCompleteness, recovery = null, independent = null, agreement = null, verification = null;
  try {
    const response = await callJson("primary_extraction", extractionMessages(testCase, index, prompt), providerSchema); calls.push(response.telemetry); primary = response.value;
    ({ extraction: primaryMaterialized, audit: spanAudit } = materializeExtractionWithAudit(primary, index, spanPolicy()));
  } catch (error) { stageErrors.push(stageError("primary_extraction_or_span_validation", error)); }
  if (!primaryMaterialized) return failedRecord("primary_extraction_or_span_validation");

  weakCompleteness = compareSignalsToExtraction(signals, primaryMaterialized);
  if (weakCompleteness.requires_recovery) {
    try {
      const missing = weakCompleteness.missing_signaled_domains;
      const signalHints = missing.map((domain) => `${domain}: source lines ${signals.domains[domain]?.line_numbers?.slice(0, 20).join(", ") || "not localized"}`).join("\n");
      const recoveryPrompt = `${prompt}\n\nRECOVERY PASS: The deterministic scanner found explicit indicators for these omitted domains: ${missing.join(", ")}. Inspect the indicated regions and return every directly supported item in those domains. Leave other domains empty. An all-empty recovery is invalid unless every indicator is historical, negated, or irrelevant; explain such uncertainty with an evidence item rather than silently returning nothing.\n${signalHints}`;
      const response = await callJson("targeted_recovery", extractionMessages(testCase, index, recoveryPrompt), providerSchema); calls.push(response.telemetry);
      const recoveredPointer = response.value;
      const recovered = materializeExtractionWithAudit(recoveredPointer, index, spanPolicy());
      recovery = { triggered: true, missing_domains: missing, pointer_extraction: recoveredPointer, span_audit: recovered.audit };
      primary = mergePointers(primary, recoveredPointer, missing);
      ({ extraction: primaryMaterialized, audit: spanAudit } = materializeExtractionWithAudit(primary, index, spanPolicy()));
      weakCompleteness = compareSignalsToExtraction(signals, primaryMaterialized);
    } catch (error) { stageErrors.push(stageError("targeted_recovery", error)); recovery = { triggered: true, error: String(error.message || error) }; }
  } else recovery = { triggered: false };

  if (runAgreement) {
    try {
      const independentPrompt = `${prompt}\n\nINDEPENDENT PASS: Start from the explicit discharge plan and work backward to supporting spans. Do not assume a previous extraction exists.`;
      const response = await callJson("independent_extraction", extractionMessages(testCase, index, independentPrompt), providerSchema); calls.push(response.telemetry);
      const materialized = materializeExtractionWithAudit(response.value, index, spanPolicy());
      independent = { pointer_extraction: response.value, extraction: materialized.extraction, span_audit: materialized.audit };
      agreement = compareExtractions(primaryMaterialized, materialized.extraction);
    } catch (error) { stageErrors.push(stageError("independent_extraction", error)); independent = { error: String(error.message || error) }; }
  }

  let candidates = independent?.extraction ? mergeCanonicalExtractions(primaryMaterialized, independent.extraction) : primaryMaterialized;
  weakCompleteness = compareSignalsToExtraction(signals, candidates);
  let accepted = candidates;
  if (runVerifier) {
    try {
      const inventory = evidenceInventory(candidates);
      const response = await callJson("semantic_verifier", verifierMessages(source, inventory), verifierSchema()); calls.push(response.telemetry);
      verification = normalizeVerification(response.value, inventory);
      accepted = filterByVerification(candidates, verification);
    } catch (error) { stageErrors.push(stageError("semantic_verifier", error)); verification = { error: String(error.message || error) }; }
  }

  let summary = "";
  try {
    const response = await callJson("evidence_only_summary", summaryMessages(testCase, accepted), summarySchema()); calls.push(response.telemetry); summary = response.value.two_page_summary;
  } catch (error) { stageErrors.push(stageError("evidence_only_summary", error)); }
  const finalExtraction = { ...accepted, two_page_summary: summary };
  const finalGate = evaluateExtraction(finalExtraction, { source, caseId: testCase.case_id, requireEvidence: true });
  const deterministicSemantics = validateEvidenceSemantics(finalExtraction);
  const abstention = finalGate.valid ? null : { required: true, reason_codes: [...new Set(finalGate.blocking.map((item) => item.code))], disposition: "withhold_output" };
  return { case_id: testCase.case_id, success: finalGate.valid, abstention, signals, pointer_extraction: primary, span_audit: spanAudit, weak_completeness: weakCompleteness, recovery, independent, agreement, candidate_extraction: candidates, verification, extraction: finalExtraction, deterministic_semantics: deterministicSemantics, final_gate: finalGate, stage_errors: stageErrors, calls, total_latency_ms: Date.now() - startedAt };

  function failedRecord(stage) { return { case_id: testCase.case_id, success: false, failure_stage: stage, signals, raw_pointer_extraction: primary || null, span_audit: spanAudit, stage_errors: stageErrors, calls, total_latency_ms: Date.now() - startedAt }; }
}

async function callJson(stage, messages, schemaValue) {
  const request = { model, max_tokens: 8000, temperature: 0, thinking: { token_budget: 512 }, response_format: { type: "json_object", schema: toProviderCompatibleSchema(schemaValue) }, messages };
  const controller = new AbortController(), timeout = Number(process.env.COHERE_TIMEOUT_MS || 120000), timer = setTimeout(() => controller.abort(), timeout), began = Date.now();
  try {
    const response = await fetch("https://api.cohere.com/v2/chat", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const body = await response.json();
    const telemetry = { stage, provider_request_id: body.id || response.headers.get("x-request-id") || null, usage: body.usage || null, finish_reason: body.finish_reason || body.message?.finish_reason || null, request_hash: sha256(JSON.stringify(request)), latency_ms: Date.now() - began };
    if (!response.ok) { const error = new Error(`Cohere API error ${response.status}: ${JSON.stringify(body)}`); error.telemetry = telemetry; throw error; }
    const text = Array.isArray(body.message?.content) ? body.message.content.map((part) => part?.text || "").join("") : String(body.message?.content || "");
    return { value: JSON.parse(text.trim()), telemetry };
  } finally { clearTimeout(timer); }
}

function extractionMessages(testCase, index, stagePrompt) { return [{ role: "system", content: systemPrompt }, { role: "user", content: `${stagePrompt}\n\nCase metadata:\n${JSON.stringify({ case_id: testCase.case_id, age: testCase.age, gender: testCase.gender, admission_diagnosis: testCase.admission_diagnosis }, null, 2)}\n\nIndexed discharge summary:\n${renderIndexedSource(index)}` }]; }
function verifierMessages(source, inventory) { return [{ role: "system", content: "You are a conservative evidence verifier. Return JSON only. Do not expose chain-of-thought." }, { role: "user", content: `For each evidence item decide whether its label and rationale are fully entailed by its quoted source span. Judge current status, negation, timing, subject, dose, route and frequency. Use supported, unsupported, or uncertain. Do not reward lexical overlap alone. Return exactly one verdict per evidence_id. Keep each reason under 12 words. Also list only the five extraction domains if clearly missing; never invent desired clinical fields.\n\nFull source context:\n${source}\n\nEvidence items:\n${JSON.stringify(inventory, null, 2)}` }]; }
function summaryMessages(testCase, extraction) { return [{ role: "system", content: "Generate a concise clinical handoff summary using only the supplied accepted evidence JSON. Return JSON only. Do not add medical advice or expose chain-of-thought." }, { role: "user", content: `Case: ${testCase.case_id}. Generate a summary of at least 80 characters. Every claim must be traceable to an accepted item; omit unsupported connective inference.\n\nAccepted evidence:\n${JSON.stringify(extraction, null, 2)}` }]; }

function verifierSchema() { return { type: "object", additionalProperties: false, required: ["items", "missing_domains"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["evidence_id", "verdict", "reason"], properties: { evidence_id: { type: "string" }, verdict: { type: "string", enum: ["supported", "unsupported", "uncertain"] }, reason: { type: "string" } } } }, missing_domains: { type: "array", items: { type: "string" } } } }; }
function summarySchema() { return { type: "object", additionalProperties: false, required: ["two_page_summary"], properties: { two_page_summary: { type: "string" } } }; }

function evidenceInventory(extraction) { const out = []; for (const [pathValue, list] of allLists(extraction)) for (const [index, item] of list.entries()) out.push({ evidence_id: `E${String(out.length + 1).padStart(4, "0")}`, path: `${pathValue}[${index}]`, label: item.label, rationale: item.rationale, source_quote: item.source_quote }); return out; }
function normalizeVerification(value, inventory) { const known = new Set(inventory.map((x) => x.evidence_id)); const items = (value.items || []).filter((x) => known.has(x.evidence_id)); const returned = new Set(items.map((x) => x.evidence_id)); for (const item of inventory) if (!returned.has(item.evidence_id)) items.push({ evidence_id: item.evidence_id, verdict: "uncertain", reason: "Verifier omitted item" }); return { items, missing_domains: value.missing_domains || [], counts: countBy(items.map((x) => x.verdict)) }; }
function filterByVerification(extraction, verification) { const inventory = evidenceInventory(extraction), verdictById = Object.fromEntries(verification.items.map((x) => [x.evidence_id, x.verdict])); const keepPaths = new Set(inventory.filter((x) => verdictById[x.evidence_id] === "supported").map((x) => x.path)); const output = structuredClone(extraction); for (const [pathValue, list] of allLists(output)) { const kept = list.filter((item, index) => keepPaths.has(`${pathValue}[${index}]`)); list.splice(0, list.length, ...kept); } return output; }
function compareExtractions(a, b) { const A = new Set(evidenceInventory(a).map(signature)), B = new Set(evidenceInventory(b).map(signature)); const intersection = [...A].filter((x) => B.has(x)).length, union = new Set([...A, ...B]).size; return { version: "independent-extraction-agreement-v1", primary_items: A.size, independent_items: B.size, exact_intersection: intersection, jaccard: union ? intersection / union : 1 }; function signature(x) { return `${x.path.replace(/\[\d+\]$/, "")}|${normalize(x.label)}|${normalize(x.source_quote)}`; } }
function mergePointers(base, recovery, domains) { const out = structuredClone(base); for (const domain of domains) { if (domain === "medication_changes") for (const key of Object.keys(out.medication_changes)) out.medication_changes[key] = dedupe([...out.medication_changes[key], ...recovery.medication_changes[key]]); else if (domain === "diagnosis_changes") for (const key of ["discharge", "new_or_changed"]) out.diagnosis_changes[key] = dedupe([...out.diagnosis_changes[key], ...recovery.diagnosis_changes[key]]); else out[domain] = dedupe([...(out[domain] || []), ...(recovery[domain] || [])]); } return out; }
function mergeCanonicalExtractions(base, extra) { const out = structuredClone(base); for (const key of Object.keys(out.medication_changes)) out.medication_changes[key] = dedupeCanonical([...out.medication_changes[key], ...extra.medication_changes[key]]); for (const key of ["discharge", "new_or_changed"]) out.diagnosis_changes[key] = dedupeCanonical([...out.diagnosis_changes[key], ...extra.diagnosis_changes[key]]); for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) out[key] = dedupeCanonical([...out[key], ...extra[key]]); return out; }
function dedupeCanonical(items) { const seen = new Set(); return items.filter((x) => { const key = `${normalize(x.label)}|${normalize(x.source_quote)}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupe(items) { const seen = new Set(); return items.filter((x) => { const key = `${normalize(x.label)}|${x.source_start_id}|${x.source_end_id}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function allLists(extraction) { const out = []; for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) out.push([`medication_changes.${key}`, extraction.medication_changes[key]]); out.push(["diagnosis_changes.discharge", extraction.diagnosis_changes.discharge], ["diagnosis_changes.new_or_changed", extraction.diagnosis_changes.new_or_changed]); for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) out.push([key, extraction[key]]); return out; }
function transformSource(source, mode) { const text = String(source || ""); if (mode === "none") return text; if (mode === "whitespace") return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"); if (mode === "rewrap") return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join("\n"); throw new Error(`Unknown source transform ${mode}`); }
function spanPolicy() { return { repairReversed: true, maxRepairSpanLines: 12, maxSpanLines: 12, dropInvalidItems: true }; }
function summarize(records) { const live = records.filter((x) => !x.dry_run); return { attempted: records.length, final_gate_passed: live.filter((x) => x.final_gate?.valid).length, recovered: live.filter((x) => x.recovery?.triggered).length, reversed_span_repairs: live.reduce((n, x) => n + (x.span_audit || []).filter((a) => a.code === "reversed_span_repaired").length, 0), verifier_counts: countBy(live.flatMap((x) => x.verification?.items || []).map((x) => x.verdict)), median_agreement_jaccard: median(live.map((x) => x.agreement?.jaccard).filter(Number.isFinite)), total_calls: live.reduce((n, x) => n + (x.calls?.length || 0), 0), stage_failures: countBy(live.flatMap((x) => x.stage_errors || []).map((x) => x.stage)) }; }
function stageError(stage, error) { return { stage, name: error.name || "Error", message: String(error.message || error), telemetry: error.telemetry || null }; }
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((x) => x === value).length])); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeName(value) { return String(value).replace(/[^a-z0-9_.-]+/gi, "_"); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
function loadEnvFile(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!match || process.env[match[1]]) continue; let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); process.env[match[1]] = value; } }
