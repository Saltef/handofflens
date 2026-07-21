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

function validateEvidenceSemantics(extraction, options = {}) {
  const issues = [];
  const sourceText = String(options.sourceText || extraction?.source_text || extraction?.source || "");
  for (const [path, list] of allEvidenceLists(extraction)) {
    for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
      const quote = normalize(item.source_quote);
      const label = String(item.label || "");
      const numbers = label.match(/\b\d+(?:\.\d+)?\b/g) || [];
      const missingNumbers = numbers.filter((number) => !new RegExp(`\\b${escapeRegex(number)}\\b`).test(quote));
      if (missingNumbers.length) issues.push({ code: "label_numeric_detail_not_in_span", path: `${path}[${index}]`, details: { missing_numbers: missingNumbers } });
      const keywords = labelKeywords(label);
      if (keywords.length && !keywords.some((word) => quote.includes(word))) issues.push({ code: "label_terms_not_in_span", path: `${path}[${index}]`, details: { checked_terms: keywords } });
      const assertion = detectAssertionStatus({ sourceText, quote: item.source_quote, label });
      if (assertion.status !== "present" && !labelAcknowledgesAssertion(label, assertion.status)) {
        issues.push({ code: "possible_assertion_status_conflict", path: `${path}[${index}]`, details: assertion });
      }
      if (path.startsWith("medication_changes.stopped") && !/\b(?:stop|stopped|discontinue|discontinued|held|avoid)\b/.test(quote)) issues.push({ code: "stopped_medication_without_stop_cue", path: `${path}[${index}]`, details: null });
      if (path === "safety_flags") validateSafetyFlag(item, `${path}[${index}]`, issues);
    }
  }
  const evidenceCorpus = allEvidenceLists(extraction).flatMap(([, list]) => Array.isArray(list) ? list.flatMap((item) => [item.label, item.rationale, item.source_quote]) : []).join(" ");
  const summaryNumbers = String(extraction?.two_page_summary || "").match(/\b\d+(?:\.\d+)?\b/g) || [];
  const unsupportedSummaryNumbers = [...new Set(summaryNumbers.filter((number) => !new RegExp(`\\b${escapeRegex(number)}\\b`).test(evidenceCorpus)))];
  if (unsupportedSummaryNumbers.length) issues.push({ code: "summary_numeric_detail_not_in_accepted_evidence", path: "two_page_summary", details: { unsupported_numbers: unsupportedSummaryNumbers } });
  return { version: "evidence-semantic-heuristics-v1", valid: issues.length === 0, issues };
}

const SAFETY_TYPES = new Set([
  "return_precaution",
  "monitoring_instruction",
  "medication_safety",
  "pending_or_critical_result",
  "source_stated_risk",
]);

function validateSafetyFlag(item, path, issues) {
  const label = String(item?.label || "");
  const quote = String(item?.source_quote || "");
  const combined = normalize(`${label} ${quote}`);
  const type = String(item?.safety_type || "");

  if (!type) {
    issues.push({ code: "missing_safety_type", path, details: { allowed: [...SAFETY_TYPES] } });
  } else if (!SAFETY_TYPES.has(type)) {
    issues.push({ code: "invalid_safety_type", path, details: { safety_type: type, allowed: [...SAFETY_TYPES] } });
  }

  if (isBroadSafetyAbstraction(label, quote)) {
    issues.push({ code: "broad_safety_abstraction", path, details: { label, safety_type: type || null } });
  }

  if (type === "return_precaution" && !/\b(?:return|call|seek|present|promptly|immediately|if|for|worsening|severe|fever|pain|redness|drainage|gain)\b/.test(combined)) {
    issues.push({ code: "return_precaution_without_trigger_cue", path, details: { label } });
  }
  if (type === "monitoring_instruction" && !/\b(?:monitor|check|record|measure|log|lab|laboratory|weight|potassium|creatinine|inr|glucose|blood pressure)\b/.test(combined)) {
    issues.push({ code: "monitoring_instruction_without_monitoring_cue", path, details: { label } });
  }
  if (type === "medication_safety" && !/\b(?:anticoag|insulin|opioid|steroid|antibiotic|renal dosing|hold|stop|toxicity|interaction|bleeding|dose|warfarin|heparin)\b/.test(combined)) {
    issues.push({ code: "medication_safety_without_medication_cue", path, details: { label } });
  }
  if (type === "pending_or_critical_result" && !/\b(?:pending|critical|result|culture|biopsy|pathology|follow up|follow-up|repeat|abnormal)\b/.test(combined)) {
    issues.push({ code: "pending_result_without_result_cue", path, details: { label } });
  }
}

function isBroadSafetyAbstraction(label, quote) {
  const labelText = normalize(label);
  const quoteText = normalize(quote);
  if (!labelText) return false;
  const broadTheme = /\b(?:monitoring required|management optimization|therapy completion monitoring|fluid status|signs of infection|wound monitoring|renal function monitoring|diabetes management|infection monitoring)\b/.test(labelText);
  if (!broadTheme) return false;
  const sourceHasAtomicCue = /\b(?:return|call|promptly|if|for|fever|severe|spreading|increasing|gain|kg|days?|check|lab|creatinine|potassium|weight)\b/.test(quoteText);
  const labelHasAtomicCue = /\b(?:fever|severe|spreading|increasing|gain|kg|days?|creatinine|potassium|weight)\b/.test(labelText);
  return sourceHasAtomicCue && !labelHasAtomicCue;
}

function detectAssertionStatus({ sourceText, quote, label, windowChars = 140 }) {
  const source = String(sourceText || "");
  const rawQuote = String(quote || "");
  const fallback = rawQuote || String(label || "");
  const located = locateQuote(source, rawQuote);
  const contextWindow = located
    ? source.slice(Math.max(0, located.start - windowChars), Math.min(source.length, located.end + windowChars))
    : fallback;
  const context = narrowAssertionContext(contextWindow, rawQuote || label);
  const normalizedContext = normalize(context);
  const normalizedQuote = normalize(rawQuote);
  const normalizedLabel = normalize(label);

  const status = classifyAssertionContext(normalizedContext, normalizedQuote, normalizedLabel);
  return {
    version: "assertion-context-window-v1",
    status,
    context_window: context,
    quote_found_in_source: Boolean(located),
  };
}

function narrowAssertionContext(context, target) {
  const text = String(context || "");
  const needle = String(target || "").trim();
  if (!text || !needle) return text;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedNeedle = normalize(needle);
  const matchingLine = lines.find((line) => normalize(line).includes(normalizedNeedle));
  if (matchingLine) return matchingLine;
  const sentences = text.split(/(?<=[.;:])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.find((sentence) => normalize(sentence).includes(normalizedNeedle)) || text;
}

function classifyAssertionContext(context, quote, label) {
  const target = quote || label;
  if (!context.trim()) return "present";
  if (hasFamilyOrOtherExperiencer(context, target)) return "associated_with_someone_else";
  if (hasHistoricalCue(context, target)) return "historical";
  if (hasHypotheticalCue(context, target)) return "hypothetical";
  if (hasConditionalCue(context, target)) return "conditional";
  if (hasPossibleCue(context, target)) return "possible";
  if (hasNegationCue(context, target)) return "absent";
  return "present";
}

function hasNegationCue(context, target) {
  const cue = /\b(?:no|not|never|without|denies?|denied|negative for|no evidence of|ruled out|free of|absence of)\b/;
  return cue.test(context) && cueNearTarget(context, target, 10, "before");
}

function hasPossibleCue(context, target) {
  const cue = /\b(?:possible|possibly|probable|probably|suspected|concern for|question of|may(?:\s+have)?|might(?:\s+have)?|could|cannot exclude|rule out|r\/o|suggests?|suggested|suggesting|indicates?|indicated|indicating|appears?|appeared|likely|possibility|potentially|putative|whether)\b/;
  return cue.test(context) && cueNearTarget(context, target, 12, "before");
}

function hasConditionalCue(context, target) {
  const cue = /\b(?:if|when|should|unless|in case of|return for|monitor for|watch for)\b/;
  return cue.test(context) && cueNearTarget(context, target, 14, "any");
}

function hasHypotheticalCue(context, target) {
  const cue = /\b(?:risk of|at risk for|would|could|consider|candidate for|planned evaluation for)\b/;
  return cue.test(context) && cueNearTarget(context, target, 14, "before");
}

function hasHistoricalCue(context, target) {
  const cue = /\b(?:history of|prior|previous|previously|remote|resolved|status post|s\/p|old)\b/;
  return cue.test(context) && cueNearTarget(context, target, 12, "before");
}

function hasFamilyOrOtherExperiencer(context, target) {
  const cue = /\b(?:family history of|mother with|father with|sister with|brother with|son with|daughter with|wife with|husband with)\b/;
  return cue.test(context) && cueNearTarget(context, target, 14, "before");
}

function cueNearTarget(context, target, maxTokens, direction) {
  const terms = labelKeywords(target).slice(0, 6);
  if (!terms.length) return false;
  const tokens = context.split(/\s+/).filter(Boolean);
  const targetPositions = [];
  tokens.forEach((token, index) => {
    if (terms.some((term) => token === term || token.includes(term) || term.includes(token))) targetPositions.push(index);
  });
  if (!targetPositions.length) return false;
  const cuePositions = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => /^(?:no|not|never|without|denies|denied|negative|ruled|possible|possibly|probable|probably|suspected|concern|question|may|might|cannot|rule|suggest|suggests|suggested|suggesting|indicate|indicates|indicated|indicating|appears|appeared|likely|possibility|potentially|putative|whether|if|when|should|unless|risk|would|could|consider|candidate|planned|history|prior|previous|previously|remote|resolved|old|family|mother|father|sister|brother|son|daughter|wife|husband)$/.test(token))
    .map(({ index }) => index);
  return cuePositions.some((cueIndex) => targetPositions.some((targetIndex) => {
    const distance = targetIndex - cueIndex;
    if (hasScopeTerminatorBetween(tokens, cueIndex, targetIndex)) return false;
    if (direction === "before") return distance >= 0 && distance <= maxTokens;
    if (direction === "after") return distance <= 0 && Math.abs(distance) <= maxTokens;
    return Math.abs(distance) <= maxTokens;
  }));
}

function hasScopeTerminatorBetween(tokens, leftIndex, rightIndex) {
  const start = Math.min(leftIndex, rightIndex) + 1;
  const end = Math.max(leftIndex, rightIndex);
  for (let index = start; index < end; index += 1) {
    if (/^(?:but|however|although|though|except|nevertheless|nonetheless|while|whereas)$/.test(tokens[index])) return true;
  }
  return false;
}

function labelAcknowledgesAssertion(label, status) {
  const text = String(label || "").toLowerCase();
  if (status === "absent") return /\b(?:no|negative|denied|ruled out|absent|without)\b/.test(text);
  if (status === "possible") return /\b(?:possible|probable|suspected|concern|rule out|cannot exclude|uncertain)\b/.test(text);
  if (status === "conditional") return /\b(?:if|when|monitor|return for|conditional)\b/.test(text);
  if (status === "hypothetical") return /\b(?:risk|consider|possible|planned|hypothetical)\b/.test(text);
  if (status === "historical") return /\b(?:history|prior|previous|remote|resolved|status post|s\/p)\b/.test(text);
  if (status === "associated_with_someone_else") return /\b(?:family history|mother|father|sister|brother|son|daughter|wife|husband)\b/.test(text);
  return false;
}

function locateQuote(source, quote) {
  const raw = String(quote || "");
  if (!source || !raw.trim()) return null;
  const exact = source.indexOf(raw);
  if (exact >= 0) return { start: exact, end: exact + raw.length };
  const normalizedSource = normalize(source);
  const normalizedQuote = normalize(raw);
  const normalizedIndex = normalizedSource.indexOf(normalizedQuote);
  if (normalizedIndex < 0) return null;
  return { start: Math.max(0, normalizedIndex), end: Math.min(source.length, normalizedIndex + raw.length) };
}

function allEvidenceLists(extraction) {
  const values = [];
  for (const key of ["started", "stopped", "changed", "continued", "uncertain"]) values.push([`medication_changes.${key}`, extraction?.medication_changes?.[key]]);
  values.push(["diagnosis_changes.discharge", extraction?.diagnosis_changes?.discharge], ["diagnosis_changes.new_or_changed", extraction?.diagnosis_changes?.new_or_changed]);
  for (const key of ["procedures_and_tests", "labs", "follow_up_actions", "safety_flags", "uncertain_items", "handoff_atoms"]) values.push([key, extraction?.[key]]);
  return values;
}

function labelKeywords(value) {
  const stop = new Set(["the", "and", "for", "with", "from", "was", "were", "daily", "tablet", "capsule", "follow", "status", "change", "continued", "started", "stopped"]);
  return normalize(value).split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !stop.has(word) && !/^\d/.test(word));
}
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim(); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function arrayLength(value) { return Array.isArray(value) ? value.length : 0; }

module.exports = { detectClinicalSignals, evidenceCounts, compareSignalsToExtraction, validateEvidenceSemantics, detectAssertionStatus, validateSafetyFlag };
