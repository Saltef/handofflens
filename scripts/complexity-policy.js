const WORD_THRESHOLD = 1800;
const DOSE_THRESHOLD = 18;
const COMBINED_WORD_THRESHOLD = 1200;

function extractComplexityFeatures(note) {
  const text = String(note || "");
  const count = (pattern) => (text.match(pattern) || []).length;
  return {
    note_words: count(/\b\w+\b/g),
    dose_mentions: count(/\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?|ml|meq)\b/gi),
    has_lab_section: /LABORATOR|PERTINENT RESULTS/i.test(text),
    has_procedure_section: /PROCEDURE|OPERATIONS?/i.test(text),
    deidentification_markers: count(/\[\*\*/g),
    numeric_tokens: count(/\b\d+(?:\.\d+)?\b/g)
  };
}

function selectComplexityRoute(note, profile = "high_sensitivity") {
  const features = extractComplexityFeatures(note);
  const reasons = [];
  const wordThreshold = profile === "conservative" ? 2200 : WORD_THRESHOLD;
  const doseThreshold = profile === "conservative" ? 24 : DOSE_THRESHOLD;
  if (!['high_sensitivity', 'balanced', 'conservative'].includes(profile)) throw new Error(`Unknown complexity profile: ${profile}`);
  if (features.note_words >= wordThreshold) reasons.push(`note_words>=${wordThreshold}`);
  if (features.dose_mentions >= doseThreshold) reasons.push(`dose_mentions>=${doseThreshold}`);
  if (profile === "high_sensitivity" && features.note_words >= COMBINED_WORD_THRESHOLD && features.has_lab_section && features.has_procedure_section) {
    reasons.push(`note_words>=${COMBINED_WORD_THRESHOLD}+lab_section+procedure_section`);
  }
  return {
    route: reasons.length ? "two_stage_complex" : "single_stage_standard",
    reasons,
    features,
    policy_profile: profile,
    policy_version: "development-complexity-policy-v1"
  };
}

module.exports = { extractComplexityFeatures, selectComplexityRoute };
