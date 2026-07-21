const crypto = require("node:crypto");

const ROOT_KEYS = ["case_id", "patient_context", "medication_changes", "diagnosis_changes", "procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items", "two_page_summary"];
const MEDICATION_BUCKETS = ["started", "stopped", "changed", "continued", "uncertain"];
const EVIDENCE_LISTS = ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"];

function evaluateExtraction(extraction, context = {}) {
  const blocking = [];
  const warnings = [];
  const source = String(context.source || "");
  const issue = (code, path, message, details) => blocking.push({ code, path, message, details: details || null });

  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) {
    issue("not_object", "$", "Extraction must be an object");
    return result(blocking, warnings, extraction);
  }
  for (const key of ROOT_KEYS) if (!(key in extraction)) issue("missing_required_field", key, `Missing required field: ${key}`);
  const extras = Object.keys(extraction).filter((key) => !ROOT_KEYS.includes(key));
  for (const key of extras) issue("unexpected_field", key, `Unexpected root field: ${key}`);
  if (context.caseId && extraction.case_id !== context.caseId) issue("case_id_mismatch", "case_id", "Output case_id does not match the requested case", { expected: context.caseId, actual: extraction.case_id });

  if (!extraction.patient_context || typeof extraction.patient_context !== "object") issue("invalid_object", "patient_context", "patient_context must be an object");
  else for (const key of ["age", "gender", "admission_diagnosis"]) if (typeof extraction.patient_context[key] !== "string") issue("invalid_string", `patient_context.${key}`, `${key} must be a string`);

  if (!extraction.medication_changes || typeof extraction.medication_changes !== "object") issue("invalid_object", "medication_changes", "medication_changes must be an object");
  else for (const bucket of MEDICATION_BUCKETS) validateEvidenceList(extraction.medication_changes[bucket], `medication_changes.${bucket}`, source, issue);

  if (!extraction.diagnosis_changes || typeof extraction.diagnosis_changes !== "object") issue("invalid_object", "diagnosis_changes", "diagnosis_changes must be an object");
  else {
    if (typeof extraction.diagnosis_changes.admission !== "string") issue("invalid_string", "diagnosis_changes.admission", "Admission diagnosis must be a string");
    validateEvidenceList(extraction.diagnosis_changes.discharge, "diagnosis_changes.discharge", source, issue);
    validateEvidenceList(extraction.diagnosis_changes.new_or_changed, "diagnosis_changes.new_or_changed", source, issue);
  }
  for (const key of EVIDENCE_LISTS) validateEvidenceList(extraction[key], key, source, issue);

  if (context.requireEvidence && allLists(extraction).every(([, list]) => !Array.isArray(list) || list.length === 0)) issue("vacuous_extraction", "$", "At least one evidence item is required for this clinical-record evaluation");

  if (typeof extraction.two_page_summary !== "string" || extraction.two_page_summary.trim().length < 80) issue("empty_or_short_summary", "two_page_summary", "Summary must contain at least 80 non-whitespace characters");
  detectDuplicates(extraction, issue);
  detectMedicationConflicts(extraction, issue);

  if (!source) warnings.push({ code: "source_not_supplied", path: "$", message: "Source-quote containment was not evaluated" });
  warnings.push({ code: "semantic_summary_support_not_deterministic", path: "two_page_summary", message: "Deterministic validation cannot establish that every narrative claim is source-supported" });
  return result(blocking, warnings, extraction);
}

function validateEvidenceList(value, path, source, issue) {
  if (!Array.isArray(value)) { issue("invalid_array", path, `${path} must be an array`); return; }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) { issue("invalid_evidence_item", itemPath, "Evidence item must be an object"); return; }
    for (const key of ["label", "rationale", "source_quote"]) if (typeof item[key] !== "string" || !item[key].trim()) issue("empty_evidence_field", `${itemPath}.${key}`, `${key} must be a non-empty string`);
    if (source && typeof item.source_quote === "string" && item.source_quote.trim() && !normalizeQuote(source).includes(normalizeQuote(item.source_quote))) issue("source_quote_not_found", `${itemPath}.source_quote`, "Source quote was not found as a contiguous lexical span after case, punctuation, Unicode, and whitespace normalization");
  });
}

function detectDuplicates(extraction, issue) {
  for (const [path, list] of allLists(extraction)) {
    if (!Array.isArray(list)) continue;
    const seen = new Map();
    list.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const key = `${normalize(item.label)}|${normalize(item.source_quote)}`;
      if (seen.has(key)) issue("duplicate_evidence_item", `${path}[${index}]`, "Duplicate evidence item", { first_index: seen.get(key) });
      else seen.set(key, index);
    });
  }
}

function detectMedicationConflicts(extraction, issue) {
  const meds = extraction.medication_changes || {};
  const index = new Map();
  for (const bucket of ["started", "stopped", "continued"]) {
    for (const item of Array.isArray(meds[bucket]) ? meds[bucket] : []) {
      const key = normalizeMedication(item.label);
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(bucket);
    }
  }
  for (const [label, buckets] of index) if (buckets.size > 1) issue("medication_state_conflict", "medication_changes", "Medication appears in mutually inconsistent state buckets", { normalized_label: label, buckets: [...buckets] });
}

function allLists(extraction) {
  const values = [];
  for (const bucket of MEDICATION_BUCKETS) values.push([`medication_changes.${bucket}`, extraction.medication_changes?.[bucket]]);
  values.push(["diagnosis_changes.discharge", extraction.diagnosis_changes?.discharge], ["diagnosis_changes.new_or_changed", extraction.diagnosis_changes?.new_or_changed]);
  for (const key of EVIDENCE_LISTS) values.push([key, extraction[key]]);
  return values;
}

function result(blocking, warnings, extraction) {
  return { gate_version: "extraction-quality-gate-v1", valid: blocking.length === 0, blocking, warnings, extraction_hash: extraction && typeof extraction === "object" ? sha256(JSON.stringify(extraction)) : null };
}
function normalize(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }
function normalizeQuote(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim(); }
function normalizeMedication(value) { return normalize(value).replace(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?|ml|meq)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

module.exports = { evaluateExtraction };
