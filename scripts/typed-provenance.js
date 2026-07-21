const { detectAssertionStatus } = require("./clinical-validation-signals");

const NORMALIZATION_PAIRS = [
  ["bid", "twice daily"],
  ["tid", "three times daily"],
  ["qid", "four times daily"],
  ["qhs", "nightly"],
  ["qday", "daily"],
  ["qd", "daily"],
  ["po", "oral"],
  ["mi", "myocardial infarction"],
  ["aki", "acute kidney injury"],
  ["ckd", "chronic kidney disease"],
  ["copd", "chronic obstructive pulmonary disease"],
  ["pe", "pulmonary embolism"],
  ["uti", "urinary tract infection"],
  ["sob", "shortness of breath"],
  ["htn", "hypertension"],
  ["dm", "diabetes mellitus"],
  ["afib", "atrial fibrillation"],
  ["debrided", "debridement"],
  ["surgically", "surgical"],
];

function classifyTypedProvenance({ sourceText, label, quote, domain }) {
  const assertion = detectAssertionStatus({ sourceText, quote, label });
  const labelText = String(label || "");
  const quoteText = String(quote || "");
  const labelNorm = normalize(labelText);
  const quoteNorm = normalize(quoteText);
  const sourceNorm = normalize(sourceText || "");
  const labelTokens = contentTokens(labelText);
  const quoteTokens = contentTokens(quoteText);
  const sourceLocated = assertion.quote_found_in_source || (quoteNorm && sourceNorm.includes(quoteNorm));
  const assertionAcknowledged = labelAcknowledgesAssertion(labelText, assertion.status);

  if (assertion.status !== "present" && !assertionAcknowledged) {
    return result("assertion_conflict", assertion, { sourceLocated, labelTokens, quoteTokens, domain });
  }
  if (!quoteNorm.trim()) {
    return result("unsupported", assertion, { sourceLocated: false, labelTokens, quoteTokens, domain });
  }
  if (labelNorm && quoteNorm.includes(labelNorm)) {
    return result("direct_quote", assertion, { sourceLocated, labelTokens, quoteTokens, domain });
  }
  if (normalizationSupported(labelNorm, quoteNorm)) {
    return result("normalized", assertion, { sourceLocated, labelTokens, quoteTokens, domain });
  }
  if (clinicalInferenceSupported(labelNorm, quoteNorm, domain)) {
    return result("inferential", assertion, { sourceLocated, labelTokens, quoteTokens, domain });
  }
  const overlap = dice(labelTokens, quoteTokens);
  if (overlap >= 0.72) {
    return result("normalized", assertion, { sourceLocated, labelTokens, quoteTokens, domain, tokenOverlap: overlap });
  }
  if (overlap >= 0.3 && sourceLocated) {
    return result("inferential", assertion, { sourceLocated, labelTokens, quoteTokens, domain, tokenOverlap: overlap });
  }
  return result("unsupported", assertion, { sourceLocated, labelTokens, quoteTokens, domain, tokenOverlap: overlap });
}

function result(type, assertion, details) {
  return {
    version: "typed-provenance-v1",
    type,
    assertion_status: assertion.status,
    quote_found_in_source: assertion.quote_found_in_source,
    context_window: assertion.context_window,
    details: {
      domain: details.domain || "",
      source_located: Boolean(details.sourceLocated),
      label_terms: details.labelTokens,
      quote_terms: details.quoteTokens,
      token_overlap: Number.isFinite(details.tokenOverlap) ? Number(details.tokenOverlap.toFixed(3)) : null,
    },
  };
}

function normalizationSupported(labelNorm, quoteNorm) {
  if (!labelNorm || !quoteNorm) return false;
  const expandedLabel = expandKnownTerms(labelNorm);
  const expandedQuote = expandKnownTerms(quoteNorm);
  return expandedQuote.includes(expandedLabel) || expandedLabel.includes(expandedQuote) || dice(contentTokens(expandedLabel), contentTokens(expandedQuote)) >= 0.72;
}

function clinicalInferenceSupported(labelNorm, quoteNorm, domain) {
  if (!labelNorm || !quoteNorm) return false;
  const expandedLabel = expandKnownTerms(labelNorm);
  const expandedQuote = expandKnownTerms(quoteNorm);
  const labelTokens = contentTokens(expandedLabel);
  const quoteTokens = contentTokens(expandedQuote);
  const overlap = dice(labelTokens, quoteTokens);

  if (/\bhypokalemia\b/.test(expandedLabel) && /\bpotassium\b/.test(expandedQuote) && /\b(replaced|corrected|3\.1|low)\b/.test(expandedQuote)) {
    return true;
  }
  if (/\bdebridement\b/.test(expandedLabel) && /\bdebridement\b/.test(expandedQuote)) {
    return true;
  }
  if (String(domain || "").includes("procedures_and_tests") || String(domain || "").includes("handoff_atoms")) {
    if (/\b(echocardiogram|radiograph|xray|x ray|cta|ct|mri|ultrasound)\b/.test(expandedLabel)
      && /\b(showed|shows|revealed|demonstrated|obtained|performed)\b/.test(expandedQuote)
      && overlap >= 0.25) return true;
  }
  if (String(domain || "").includes("medication_changes") || String(domain || "").includes("handoff_atoms")) {
    if (/\b(stopped|started|increased|decreased|continued)\b/.test(expandedLabel)
      && /\b(stopped|started|increased|decreased|continued|replaced)\b/.test(expandedQuote)
      && overlap >= 0.25) return true;
  }
  return false;
}

function expandKnownTerms(value) {
  let text = ` ${normalize(value)} `;
  for (const [short, long] of NORMALIZATION_PAIRS) {
    text = text.replace(new RegExp(`\\b${escapeRegex(short)}\\b`, "g"), long);
  }
  return normalize(text);
}

function labelAcknowledgesAssertion(label, status) {
  const text = String(label || "").toLowerCase();
  if (status === "present") return true;
  if (status === "absent") return /\b(?:no|negative|denied|ruled out|absent|without)\b/.test(text);
  if (status === "possible") return /\b(?:possible|probable|suspected|concern|rule out|cannot exclude|uncertain)\b/.test(text);
  if (status === "conditional") return /\b(?:if|when|monitor|return for|conditional)\b/.test(text);
  if (status === "hypothetical") return /\b(?:risk|consider|planned|hypothetical)\b/.test(text);
  if (status === "historical") return /\b(?:history|prior|previous|remote|resolved|status post|s\/p)\b/.test(text);
  if (status === "associated_with_someone_else") return /\b(?:family history|mother|father|sister|brother|son|daughter|wife|husband)\b/.test(text);
  return false;
}

function contentTokens(value) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "patient",
    "discharge",
    "continued",
    "started",
    "changed",
    "stopped",
    "performed",
    "showed",
    "shows",
    "showing",
    "revealed",
    "demonstrated",
    "obtained",
    "completed",
    "because",
    "surgical",
    "daily",
    "nightly",
    "tablet",
    "capsule",
  ]);
  return normalize(value).split(/\s+/).filter((token) => token.length >= 3 && !stop.has(token));
}

function dice(left, right) {
  if (!left.length || !right.length) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { classifyTypedProvenance, contentTokens, expandKnownTerms };
