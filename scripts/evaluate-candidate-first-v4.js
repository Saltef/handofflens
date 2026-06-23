#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { generateCandidates } = require("./candidate-first-index");
const { evaluateExtraction } = require("./extraction-quality-gate");
const { validateEvidenceSemantics } = require("./clinical-validation-signals");
const { toProviderCompatibleSchema } = require("./schema-utils");

loadEnvFile(".env");
const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/dataset_sample_representative_500.json";
const outDir = args["out-dir"] || "results/candidate-first-v4-dev20";
const start = Number(args.start || 0), limit = Number(args.limit || 20);
const dryRun = Boolean(args["dry-run"]), force = Boolean(args.force);
const selectionRepeats = Number(args["selection-repeats"] || 1);
const sourceTransform = args["source-transform"] || "none";
const model = args.model || "command-a-plus-05-2026";
const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
if (!Number.isInteger(start) || !Number.isInteger(limit) || start < 0 || start + limit > cases.length) throw new Error("Invalid range");
if (![1, 2, 3].includes(selectionRepeats)) throw new Error("selection-repeats must be 1, 2, or 3");
if (!dryRun && !process.env.COHERE_API_KEY) throw new Error("Missing COHERE_API_KEY");
fs.mkdirSync(outDir, { recursive: true });

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

async function main() {
  const manifest = { experiment_id: "candidate-first-v4-development", created_at: new Date().toISOString(), cases_path: casesPath, cases_sha256: sha256(fs.readFileSync(casesPath)), range: { start, limit }, model, source_index: "canonical-source-map-v1", candidate_generator: "candidate-first-index-v1", selection_repeats: selectionRepeats, source_transform: sourceTransform, generation: { temperature: 0, seed: Number(process.env.COHERE_SEED || 20260622) }, reasoning: { hidden: true, token_budget: 512, chain_of_thought_stored: false }, retries: { provider: 0, recovery: 1 }, claims_boundary: "Automated development evidence only; no clinical correctness or safety claim." };
  writeJson(path.join(outDir, "manifest.json"), manifest);
  const records = [];
  for (const testCase of cases.slice(start, start + limit)) {
    const file = path.join(outDir, `${safeName(testCase.case_id)}.json`);
    if (!force && fs.existsSync(file)) { records.push(JSON.parse(fs.readFileSync(file, "utf8"))); continue; }
    const source = transformSource(testCase.discharge_summary, sourceTransform), index = generateCandidates(source);
    let record;
    if (dryRun) record = { case_id: testCase.case_id, dry_run: true, source_sha256: sha256(source), candidate_count: index.candidates.length, candidate_ids_sha256: sha256(index.candidates.map((x) => x.candidate_id).join("|")), overflow: index.overflow, detected_domains: index.detected_domains };
    else record = await runCase(testCase, source, index);
    writeJson(file, record); records.push(record);
    if (!dryRun) console.log(`${testCase.case_id}: ${record.final_gate?.valid ? "PASS" : "ABSTAIN"}`);
  }
  const summary = summarize(records); writeJson(path.join(outDir, "combined.json"), { manifest, summary, records }); console.log(JSON.stringify(summary, null, 2));
}

async function runCase(testCase, source, index) {
  const began = Date.now(), calls = [], errors = [], selectionRuns = [];
  const deterministicSelections = selectExplicitSectionCandidates(index.candidates);
  const modelCandidates = index.candidates.filter((x) => x.origin !== "section_entry");
  if (modelCandidates.length) {
    const schema = selectionSchema(modelCandidates);
    for (let repeat = 0; repeat < selectionRepeats; repeat += 1) {
      try { const response = await callJson(`selection_${repeat + 1}`, selectionMessages(testCase, modelCandidates, false), schema); calls.push(response.telemetry); selectionRuns.push(response.value); }
      catch (error) { errors.push(stageError(`selection_${repeat + 1}`, error)); }
    }
  }
  const agreement = compareSelections(selectionRuns);
  let selected = [...deterministicSelections, ...consensusSelections(selectionRuns, selectionRepeats)], audit = [];
  const validated = validateSelections(selected, index.candidates); selected = validated.selected; audit = validated.audit;
  let extraction = materialize(testCase, selected, index.candidates);
  let missingDomains = detectedMissingDomains(index, extraction), recovery = { triggered: false };
  if (missingDomains.length) {
    const recoveryCandidates = index.candidates.filter((x) => missingDomains.includes(x.domain_hint));
    try {
      const response = await callJson("targeted_recovery", selectionMessages(testCase, recoveryCandidates, true), selectionSchema(recoveryCandidates)); calls.push(response.telemetry);
      const checked = validateSelections(response.value.selected || [], recoveryCandidates);
      recovery = { triggered: true, domains: missingDomains, selected_count: checked.selected.length, audit: checked.audit };
      selected = dedupeSelections([...selected, ...checked.selected]); audit.push(...checked.audit); extraction = materialize(testCase, selected, index.candidates); missingDomains = detectedMissingDomains(index, extraction);
    } catch (error) { errors.push(stageError("targeted_recovery", error)); recovery = { triggered: true, domains: missingDomains, error: String(error.message || error) }; }
  }
  let summary = "";
  if (countEvidence(extraction) > 0) {
    try { const response = await callJson("evidence_only_summary", summaryMessages(testCase, extraction), summarySchema()); calls.push(response.telemetry); summary = response.value.two_page_summary; }
    catch (error) { errors.push(stageError("evidence_only_summary", error)); }
  }
  extraction.two_page_summary = summary;
  const finalGate = evaluateExtraction(extraction, { source, caseId: testCase.case_id, requireEvidence: true });
  const deterministicSemantics = validateEvidenceSemantics(extraction);
  const sectionCoverage = computeSectionCoverage(index.candidates, selected);
  const abstention = finalGate.valid ? null : { required: true, disposition: "withhold_output", reason_codes: [...new Set(finalGate.blocking.map((x) => x.code))], missing_domains: missingDomains };
  return { case_id: testCase.case_id, success: finalGate.valid, abstention, candidate_index: { version: index.version, count: index.candidates.length, model_candidate_count: modelCandidates.length, deterministic_section_count: deterministicSelections.length, overflow: index.overflow, detected_domains: index.detected_domains, candidate_ids: index.candidates.map((x) => x.candidate_id) }, deterministic_section_selections: deterministicSelections, selection_runs: selectionRuns, selection_agreement: agreement, selected_candidates: selected, section_coverage: sectionCoverage, selection_audit: audit, recovery, extraction, deterministic_semantics: deterministicSemantics, final_gate: finalGate, calls, stage_errors: errors, total_latency_ms: Date.now() - began };
}

function selectionMessages(testCase, candidates, recovery) {
  const mode = recovery ? "TARGETED RECOVERY" : "PRIMARY SELECTION";
  return [{ role: "system", content: "You select explicitly supported clinical evidence candidates. Return JSON only. Use hidden reasoning but never reveal chain-of-thought." }, { role: "user", content: `${mode}. Select candidates that explicitly support a discharge-relevant clinical fact. Candidates with origin=section_entry were deterministically parsed from an explicit discharge-domain section and should normally be selected unless negated, historical, malformed, or irrelevant. Do not dump candidates into uncertain merely to avoid classification. Use uncertain only for genuine status ambiguity. Do not invent candidate IDs, spans, quotations, diagnoses, or medication changes. Assign exactly one allowed category. A discharge medication list supports medication_continued/current-at-discharge unless the text explicitly supports started, stopped, or changed. Keep labels factual and rationales under 18 words. An empty selection requires a concise abstention_reason.\n\nCase metadata:\n${JSON.stringify({ case_id: testCase.case_id, age: testCase.age, gender: testCase.gender, admission_diagnosis: testCase.admission_diagnosis }, null, 2)}\n\nCandidates:\n${JSON.stringify(candidates.map((x) => ({ candidate_id: x.candidate_id, domain_hint: x.domain_hint, origin: x.origin, text: x.canonical_text })), null, 2)}` }];
}
function summaryMessages(testCase, extraction) { return [{ role: "system", content: "Generate a concise handoff summary from accepted evidence JSON only. Return JSON; do not reveal chain-of-thought." }, { role: "user", content: `Generate a summary of at least 80 characters for ${testCase.case_id}. Every factual detail, including numbers, must occur in accepted evidence. Do not add advice or unsupported implications.\n\nAccepted evidence:\n${JSON.stringify(extraction, null, 2)}` }]; }

async function callJson(stage, messages, schema) {
  const request = { model, max_tokens: 8000, temperature: 0, seed: Number(process.env.COHERE_SEED || 20260622), thinking: { token_budget: 512 }, response_format: { type: "json_object", schema: toProviderCompatibleSchema(schema) }, messages };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Number(process.env.COHERE_TIMEOUT_MS || 120000)), began = Date.now();
  try {
    const response = await fetch("https://api.cohere.com/v2/chat", { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const body = await response.json(), telemetry = { stage, provider_request_id: body.id || response.headers.get("x-request-id") || null, usage: body.usage || null, finish_reason: body.finish_reason || body.message?.finish_reason || null, request_hash: sha256(JSON.stringify(request)), latency_ms: Date.now() - began };
    if (!response.ok) { const error = new Error(`Cohere API error ${response.status}: ${JSON.stringify(body)}`); error.telemetry = telemetry; throw error; }
    const text = Array.isArray(body.message?.content) ? body.message.content.map((x) => x?.text || "").join("") : String(body.message?.content || "");
    return { value: JSON.parse(text.trim()), telemetry };
  } finally { clearTimeout(timer); }
}

function selectionSchema(candidates) { const ids = candidates.map((x) => x.candidate_id); return { type: "object", additionalProperties: false, required: ["selected", "uncertain_candidate_ids", "abstention_reason"], properties: { selected: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidate_id", "category", "label", "rationale"], properties: { candidate_id: { type: "string", enum: ids }, category: { type: "string", enum: categories() }, label: { type: "string" }, rationale: { type: "string" } } } }, uncertain_candidate_ids: { type: "array", items: { type: "string", enum: ids } }, abstention_reason: { type: "string" } } }; }
function summarySchema() { return { type: "object", additionalProperties: false, required: ["two_page_summary"], properties: { two_page_summary: { type: "string" } } }; }
function categories() { return ["medication_started", "medication_stopped", "medication_changed", "medication_continued", "medication_uncertain", "diagnosis_discharge", "diagnosis_new_or_changed", "procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]; }

function selectExplicitSectionCandidates(candidates) { return candidates.filter((x) => x.origin === "section_entry").map((candidate) => { const text = extractiveLabel(candidate); let category; if (candidate.domain_hint === "medication_changes") { if (/\b(?:stop|stopped|discontinue|discontinued|held)\b/i.test(text)) category = "medication_stopped"; else if (/\b(?:taper|increase|decrease|reduce|changed|change from|change to)\b/i.test(text)) category = "medication_changed"; else if (/\b(?:start|started|initiate|initiated|newly)\b/i.test(text)) category = "medication_started"; else category = "medication_continued"; } else if (candidate.domain_hint === "diagnosis_changes") category = "diagnosis_discharge"; else category = candidate.domain_hint; return { candidate_id: candidate.candidate_id, category, label: text, rationale: `Parsed from explicit ${candidate.domain_hint.replace(/_/g, " ")} section.` }; }); }

function validateSelections(values, candidates) { const byId = Object.fromEntries(candidates.map((x) => [x.candidate_id, x])), selected = [], audit = []; for (const item of Array.isArray(values) ? values : []) { const candidate = byId[item.candidate_id]; if (!candidate) { audit.push({ code: "unknown_candidate_rejected", candidate_id: item.candidate_id }); continue; } if (!String(item.label || "").trim() || !String(item.rationale || "").trim()) { audit.push({ code: "empty_selection_field_rejected", candidate_id: item.candidate_id }); continue; } if (!domainCompatible(candidate.domain_hint, item.category)) { audit.push({ code: "domain_category_conflict_rejected", candidate_id: item.candidate_id, domain_hint: candidate.domain_hint, category: item.category }); continue; } selected.push({ candidate_id: item.candidate_id, category: item.category, label: String(item.label).trim(), rationale: String(item.rationale).trim() }); } return { selected: dedupeSelections(selected), audit }; }
function domainCompatible(domain, category) { if (domain === "medication_changes") return category.startsWith("medication_"); if (domain === "diagnosis_changes") return category.startsWith("diagnosis_") || category === "uncertain_items"; return category === domain || category === "safety_flags" || category === "uncertain_items"; }
function consensusSelections(runs, repeatCount) { if (!runs.length) return []; const all = runs.flatMap((run) => run.selected || []), counts = countBy(all.map((x) => `${x.candidate_id}|${x.category}`)); const threshold = repeatCount === 1 ? 1 : repeatCount === 2 ? 2 : Math.ceil(repeatCount / 2); return all.filter((item, index) => counts[`${item.candidate_id}|${item.category}`] >= threshold && all.findIndex((x) => x.candidate_id === item.candidate_id && x.category === item.category) === index); }
function compareSelections(runs) { if (runs.length < 2) return null; const sets = runs.map((run) => new Set((run.selected || []).map((x) => `${x.candidate_id}|${x.category}`))), pairs = []; for (let i = 0; i < sets.length; i += 1) for (let j = i + 1; j < sets.length; j += 1) { const intersection = [...sets[i]].filter((x) => sets[j].has(x)).length, union = new Set([...sets[i], ...sets[j]]).size; pairs.push(union ? intersection / union : 1); } return { pairwise_jaccard: pairs, mean_jaccard: pairs.reduce((a, b) => a + b, 0) / pairs.length }; }

function materialize(testCase, selections, candidates) { const byId = Object.fromEntries(candidates.map((x) => [x.candidate_id, x])), extraction = emptyExtraction(testCase); for (const selection of selections) { const candidate = byId[selection.candidate_id]; if (!candidate) continue; const item = { label: extractiveLabel(candidate), rationale: candidate.origin === "section_entry" ? `Parsed from explicit ${candidate.domain_hint.replace(/_/g, " ")} section.` : "Selected from an explicit source candidate.", source_quote: candidate.source_quote }; const target = targetList(extraction, selection.category); target.push(item); } for (const [, list] of allLists(extraction)) dedupeEvidenceInPlace(list); return extraction; }
function extractiveLabel(candidate) { return String(candidate.canonical_text || "").replace(/^(?:\?{3,}|\d{1,2}[.)]|[-*])\s*/, "").trim().slice(0, 300); }
function emptyExtraction(testCase) { return { case_id: testCase.case_id, patient_context: { age: String(testCase.age || ""), gender: String(testCase.gender || ""), admission_diagnosis: String(testCase.admission_diagnosis || "") }, medication_changes: { started: [], stopped: [], changed: [], continued: [], uncertain: [] }, diagnosis_changes: { admission: String(testCase.admission_diagnosis || ""), discharge: [], new_or_changed: [] }, procedures_and_tests: [], labs: [], follow_up_actions: [], safety_flags: [], uncertain_items: [], two_page_summary: "" }; }
function targetList(extraction, category) { const map = { medication_started: extraction.medication_changes.started, medication_stopped: extraction.medication_changes.stopped, medication_changed: extraction.medication_changes.changed, medication_continued: extraction.medication_changes.continued, medication_uncertain: extraction.medication_changes.uncertain, diagnosis_discharge: extraction.diagnosis_changes.discharge, diagnosis_new_or_changed: extraction.diagnosis_changes.new_or_changed, procedures_and_tests: extraction.procedures_and_tests, labs: extraction.labs, follow_up_actions: extraction.follow_up_actions, safety_flags: extraction.safety_flags, uncertain_items: extraction.uncertain_items }; return map[category]; }
function detectedMissingDomains(index, extraction) { const counts = { medication_changes: Object.values(extraction.medication_changes).reduce((n, x) => n + x.length, 0), diagnosis_changes: extraction.diagnosis_changes.discharge.length + extraction.diagnosis_changes.new_or_changed.length, procedures_and_tests: extraction.procedures_and_tests.length, labs: extraction.labs.length, follow_up_actions: extraction.follow_up_actions.length }; const explicitDomains = new Set(index.candidates.filter((x) => x.origin === "section_entry").map((x) => x.domain_hint)); return [...explicitDomains].filter((domain) => counts[domain] === 0); }
function computeSectionCoverage(candidates, selected) { const chosen = new Set(selected.map((x) => x.candidate_id)), section = candidates.filter((x) => x.origin === "section_entry"), byDomain = {}; for (const domain of [...new Set(section.map((x) => x.domain_hint))]) { const items = section.filter((x) => x.domain_hint === domain), accepted = items.filter((x) => chosen.has(x.candidate_id)).length; byDomain[domain] = { candidates: items.length, selected: accepted, rate: items.length ? accepted / items.length : null }; } const selectedCount = section.filter((x) => chosen.has(x.candidate_id)).length; return { version: "explicit-section-coverage-v1", candidates: section.length, selected: selectedCount, rate: section.length ? selectedCount / section.length : null, by_domain: byDomain }; }
function dedupeSelections(items) { const seen = new Set(); return items.filter((x) => { const key = `${x.candidate_id}|${x.category}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function dedupeEvidenceInPlace(list) { const seen = new Set(), kept = list.filter((x) => { const key = `${normalize(x.label)}|${normalize(x.source_quote)}`; if (seen.has(key)) return false; seen.add(key); return true; }); list.splice(0, list.length, ...kept); }
function allLists(extraction) { return [...Object.entries(extraction.medication_changes).map(([key, list]) => [`medication_changes.${key}`, list]), ["diagnosis_changes.discharge", extraction.diagnosis_changes.discharge], ["diagnosis_changes.new_or_changed", extraction.diagnosis_changes.new_or_changed], ...["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"].map((key) => [key, extraction[key]])]; }
function countEvidence(extraction) { return allLists(extraction).reduce((n, [, list]) => n + list.length, 0); }
function transformSource(source, mode) { const text = String(source || ""); if (mode === "none") return text; if (mode === "whitespace") return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n"); if (mode === "rewrap") return text.replace(/\s+/g, " ").trim(); throw new Error(`Unknown source transform ${mode}`); }
function summarize(records) { const live = records.filter((x) => !x.dry_run); return { attempted: records.length, final_gate_passed: live.filter((x) => x.final_gate?.valid).length, abstained: live.filter((x) => x.abstention?.required).length, recovered: live.filter((x) => x.recovery?.triggered).length, candidate_overflow_cases: records.filter((x) => (x.candidate_index?.overflow?.count || x.overflow?.count || 0) > 0).length, median_section_coverage: median(live.map((x) => x.section_coverage?.rate).filter(Number.isFinite)), median_selection_jaccard: median(live.map((x) => x.selection_agreement?.mean_jaccard).filter(Number.isFinite)), minimum_selection_jaccard: minimum(live.map((x) => x.selection_agreement?.mean_jaccard).filter(Number.isFinite)), total_calls: live.reduce((n, x) => n + x.calls.length, 0), stage_failures: countBy(live.flatMap((x) => x.stage_errors).map((x) => x.stage)) }; }
function stageError(stage, error) { return { stage, name: error.name || "Error", message: String(error.message || error), telemetry: error.telemetry || null }; }
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((x) => x === value).length])); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function minimum(values) { return values.length ? Math.min(...values) : null; }
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeName(value) { return String(value).replace(/[^a-z0-9_.-]+/gi, "_"); }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { if (!argv[i].startsWith("--")) continue; const key = argv[i].slice(2), next = argv[i + 1]; if (!next || next.startsWith("--")) out[key] = true; else { out[key] = next; i += 1; } } return out; }
function loadEnvFile(file) { if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (!match || process.env[match[1]]) continue; let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); process.env[match[1]] = value; } }
