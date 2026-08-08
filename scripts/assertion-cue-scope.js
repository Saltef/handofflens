const NEGATION_ACK_RE = /\b(?:no|not|without|denies|denied|negative|resolved|ruled out|rule out)\b/;
const UNCERTAINTY_ACK_RE = /\b(?:possible|possibly|probable|probably|suspected|suspicion|concern|concern for|cannot exclude|may represent)\b/;

const CUE_FAMILIES = {
  negation: {
    ack: NEGATION_ACK_RE,
    phrases: [
      ["cannot", "rule", "out"],
      ["ruled", "out"],
      ["rule", "out"],
      ["denies"],
      ["denied"],
      ["without"],
      ["negative"],
      ["resolved"],
      ["not"],
      ["no"],
    ],
  },
  uncertainty: {
    ack: UNCERTAINTY_ACK_RE,
    phrases: [
      ["cannot", "exclude"],
      ["may", "represent"],
      ["concern", "for"],
      ["possible"],
      ["possibly"],
      ["probable"],
      ["probably"],
      ["suspected"],
      ["suspicion"],
      ["concern"],
    ],
  },
};

const TARGET_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "without",
  "patient",
  "patients",
  "status",
  "change",
  "changed",
  "completion",
  "compliance",
  "course",
  "care",
  "follow",
  "followup",
  "up",
  "evaluation",
  "monitoring",
  "test",
  "tests",
  "procedure",
  "procedures",
  "result",
  "results",
  "study",
  "studies",
]);

function hasAssertionCueConflict(text, label, options = {}) {
  const source = normalizeAssertionText(text);
  const item = normalizeAssertionText(label);
  if (!source || !item) return false;
  return hasFamilyConflict(source, item, "negation", options) || hasFamilyConflict(source, item, "uncertainty", options);
}

function hasFamilyConflict(source, label, familyName, options) {
  const family = CUE_FAMILIES[familyName];
  if (family.ack.test(label)) return false;
  const labelTargets = new Set(assertionTargetTokens(label));
  const units = assertionScopeUnits(source);

  for (const unit of units) {
    const scopedTokens = scopedCueTokens(unit, familyName);
    if (!scopedTokens.length) continue;
    if (!hasOverlap(scopedTokens, labelTargets)) continue;
    if (isDiagnosticResultQualifier(unit, label, familyName, options)) continue;
    return true;
  }
  return false;
}

function scopedCueTokens(unit, familyName) {
  const family = CUE_FAMILIES[familyName];
  const tokens = lexicalTokens(unit, { keepStopwords: true });
  const out = [];
  for (const phrase of family.phrases) {
    for (const index of phraseIndexes(tokens, phrase)) {
      const before = familyName === "negation" && /^(?:negative|resolved)$/.test(phrase[0]) ? 8 : 3;
      const after = familyName === "uncertainty" ? 10 : 8;
      const start = Math.max(0, index - before);
      const end = Math.min(tokens.length, index + phrase.length + after);
      out.push(...lexicalTokens(tokens.slice(start, end).join(" ")));
    }
  }
  return [...new Set(out)];
}

function assertionScopeUnits(source) {
  return normalizeAssertionText(source)
    .split(/(?:[.;|()[\]{}]|\s+-\s+|\bbut\b|\bhowever\b|\bthough\b|\balthough\b)/i)
    .map((unit) => unit.trim())
    .filter(Boolean);
}

function assertionTargetTokens(value) {
  return lexicalTokens(value)
    .filter((token) => token.length > 1)
    .filter((token) => !TARGET_STOPWORDS.has(token));
}

function lexicalTokens(value, options = {}) {
  const tokens = String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[\*\*[^\]]+\*\*\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return options.keepStopwords ? tokens : tokens.filter((token) => !TARGET_STOPWORDS.has(token));
}

function phraseIndexes(tokens, phrase) {
  const out = [];
  for (let i = 0; i <= tokens.length - phrase.length; i += 1) {
    if (phrase.every((token, offset) => tokens[i + offset] === token)) out.push(i);
  }
  return out;
}

function hasOverlap(tokens, targetSet) {
  if (!targetSet.size) return tokens.length > 0;
  return tokens.some((token) => targetSet.has(token));
}

function isDiagnosticResultQualifier(unit, label, familyName, options = {}) {
  if (familyName !== "negation") return false;
  const domain = String(options.domain || "");
  if (domain !== "lab" && domain !== "procedure_or_test") return false;
  const text = normalizeAssertionText(unit);
  const item = normalizeAssertionText(label);
  const hasTestFrame = /\b(?:culture|ct|mri|xray|x-ray|scan|ultrasound|egd|endoscopy|puncture|catheterization|catheterisation|imaging|test|study|screen|evaluation|workup|performed|completed|obtained|sent)\b/.test(item);
  const hasResultNegation = /\b(?:no growth|no evidence|negative|not anthracis|without evidence|rule out|ruled out|without complication|without event)\b/.test(text);
  const labelClaimsPositiveResult = /\b(?:positive|grew|growth|showed|revealed|demonstrated|evidence of|consistent with)\b/.test(item);
  return hasTestFrame && hasResultNegation && !labelClaimsPositiveResult;
}

function normalizeAssertionText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

module.exports = {
  hasAssertionCueConflict,
  assertionTargetTokens,
  assertionScopeUnits,
};
