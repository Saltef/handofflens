const DOMAINS = {
  medication_changes: [/\bdischarge medications?\b/i, /\bmedications? on discharge\b/i, /\bmedications?\s*:/i],
  diagnosis_changes: [/\bdischarge diagnoses?\b/i, /\bfinal diagnoses?\b/i, /\bprincipal diagnoses?\b/i],
  procedures_and_tests: [/\bmajor surgical or invasive procedure\b/i, /\bprocedures?\b/i, /\boperations?\b/i, /\b(?:ct|mri|x-?ray|echocardiogram|ultrasound)\b/i],
  labs: [/\bpertinent results?\b/i, /\blaborator(?:y|ies)\b/i, /\b(?:wbc|hemoglobin|hgb|creatinine|sodium|potassium)\b/i],
  follow_up_actions: [/\bfollow\s*-?\s*up\b/i, /\bdischarge instructions?\b/i, /\bappointments?\b/i]
};

function detectClinicalSignals(source) {
  const lines = String(source || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const domains = {};
  for (const [domain, patterns] of Object.entries(DOMAINS)) {
    const matched = [];
    lines.forEach((line, index) => { if (patterns.some((pattern) => pattern.test(line))) matched.push({ line_number: index + 1, text_hash_input: line }); });
    domains[domain] = { present: matched.length > 0, match_count: matched.length, line_numbers: matched.map((item) => item.line_number) };
  }
  return { version: "clinical-section-signals-v1", line_count: lines.length, domains };
}

function evidenceCounts(extraction) {
  const meds = extraction?.medication_changes || {};
  return {
    medication_changes: ["started", "stopped", "changed", "continued", "uncertain"].reduce((sum, key) => sum + arrayLength(meds[key]), 0),
    diagnosis_changes: arrayLength(extraction?.diagnosis_changes?.discharge) + arrayLength(extraction?.diagnosis_changes?.new_or_changed),
    procedures_and_tests: arrayLength(extraction?.procedures_and_tests),
    labs: arrayLength(extraction?.labs),
    follow_up_actions: arrayLength(extraction?.follow_up_actions)
  };
}

function compareSignalsToExtraction(signals, extraction) {
  const counts = evidenceCounts(extraction);
  const missing = Object.entries(signals.domains)
    .filter(([domain, signal]) => signal.present && counts[domain] === 0)
    .map(([domain]) => domain);
  return { version: "weak-completeness-v1", counts, missing_signaled_domains: missing, requires_recovery: missing.length > 0 };
}

function validateEvidenceSemantics(extraction) {
  const issues = [];
  for (const [path, list] of allEvidenceLists(extraction)) {
    for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
      const quote = normalize(item.source_quote);
      const label = String(item.label || "");
      const numbers = label.match(/\b\d+(?:\.\d+)?\b/g) || [];
      const missingNumbers = numbers.filter((number) => !new RegExp(`\\b${escapeRegex(number)}\\b`).test(quote));
      if (missingNumbers.length) issues.push({ code: "label_numeric_detail_not_in_span", path: `${path}[${index}]`, details: { missing_numbers: missingNumbers } });
      const keywords = labelKeywords(label);
      if (keywords.length && !keywords.some((word) => quote.includes(word))) issues.push({ code: "label_terms_not_in_span", path: `${path}[${index}]`, details: { checked_terms: keywords } });
      if (/\b(?:denies?|denied|no evidence of|negative for|ruled out)\b/.test(quote) && !/uncertain|negative|denied|ruled out|no /i.test(label)) issues.push({ code: "possible_negation_conflict", path: `${path}[${index}]`, details: null });
      if (path.startsWith("medication_changes.stopped") && !/\b(?:stop|stopped|discontinue|discontinued|held|avoid)\b/.test(quote)) issues.push({ code: "stopped_medication_without_stop_cue", path: `${path}[${index}]`, details: null });
    }
  }
  const evidenceCorpus = allEvidenceLists(extraction).flatMap(([, list]) => Array.isArray(list) ? list.flatMap((item) => [item.label, item.rationale, item.source_quote]) : []).join(" ");
  const summaryNumbers = String(extraction?.two_page_summary || "").match(/\b\d+(?:\.\d+)?\b/g) || [];
  const unsupportedSummaryNumbers = [...new Set(summaryNumbers.filter((number) => !new RegExp(`\\b${escapeRegex(number)}\\b`).test(evidenceCorpus)))];
  if (unsupportedSummaryNumbers.length) issues.push({ code: "summary_numeric_detail_not_in_accepted_evidence", path: "two_page_summary", details: { unsupported_numbers: unsupportedSummaryNumbers } });
  return { version: "evidence-semantic-heuristics-v1", valid: issues.length === 0, issues };
}

function allEvidenceLists(extraction) {
  const values = [];
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) values.push([`medication_changes.${key}`, extraction?.medication_changes?.[key]]);
  values.push(["diagnosis_changes.discharge", extraction?.diagnosis_changes?.discharge], ["diagnosis_changes.new_or_changed", extraction?.diagnosis_changes?.new_or_changed]);
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items"]) values.push([key, extraction?.[key]]);
  return values;
}

function labelKeywords(value) {
  const stop = new Set(["the", "and", "for", "with", "from", "was", "were", "daily", "tablet", "capsule", "follow", "status", "change", "continued", "started", "stopped"]);
  return normalize(value).split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !stop.has(word) && !/^\d/.test(word));
}
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim(); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function arrayLength(value) { return Array.isArray(value) ? value.length : 0; }

module.exports = { detectClinicalSignals, evidenceCounts, compareSignalsToExtraction, validateEvidenceSemantics };
