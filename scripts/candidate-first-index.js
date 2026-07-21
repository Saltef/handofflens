const crypto = require("node:crypto");

const HEADINGS = [
  ["medication_changes", /\b(?:DISCHARGE MEDICATIONS?|MEDICATIONS? ON DISCHARGE)\s*:/gi],
  ["diagnosis_changes", /\b(?:DISCHARGE DIAGNOSES?|FINAL DIAGNOSES?|PRINCIPAL DIAGNOSES?)\s*:/gi],
  ["procedures_and_tests", /\b(?:MAJOR SURGICAL OR INVASIVE PROCEDURE|PROCEDURES?|OPERATIONS?)\s*:/gi],
  ["labs", /\b(?:PERTINENT RESULTS?|LABORATOR(?:Y|IES)(?: ON ADMISSION)?)\s*:/gi],
  ["follow_up_actions", /\b(?:DISCHARGE FOLLOWUP|FOLLOWUP INSTRUCTIONS?|FOLLOW[- ]?UP|DISCHARGE INSTRUCTIONS?)\s*:/gi]
];
const CUES = {
  medication_changes: /\b(?:mg|mcg|units?|tablet|capsule|p\.o\.|po\b|bid\b|tid\b|q\.?d\.?|daily|medication|prednisone|insulin|aspirin|antibiotic)\b/i,
  diagnosis_changes: /\b(?:diagnos|assessment|impression|failure|syndrome|disease|pneumonia|infection|exacerbation|hypertension|infarction)\b/i,
  procedures_and_tests: /\b(?:procedure|surgery|operation|performed|underwent|ct\b|mri\b|x-?ray|ultrasound|echocardiogram|biopsy|catheter|intubat|extubat|bronchoscopy)\b/i,
  labs: /\b(?:wbc|hgb|hemoglobin|hematocrit|platelets?|creatinine|bun\b|sodium|potassium|glucose|inr\b|troponin|laborator|ph\b|pco2)\b/i,
  follow_up_actions: /\b(?:follow\s*-?\s*up|appointment|clinic|within\s+\w+\s+(?:day|week|month)|return to|call\s+.*clinic|scheduled)\b/i
};

function canonicalizeWithMap(source) {
  const input = String(source || "");
  let text = "", inWhitespace = false, whitespaceStart = -1;
  const starts = [], ends = [];
  for (let i = 0; i < input.length; i += 1) {
    if (/\s/.test(input[i])) { if (!inWhitespace) { inWhitespace = true; whitespaceStart = i; } continue; }
    if (inWhitespace && text.length) { text += " "; starts.push(whitespaceStart); ends.push(i); }
    inWhitespace = false;
    text += input[i]; starts.push(i); ends.push(i + 1);
  }
  return { version: "canonical-source-map-v1", source: input, text: text.trim(), starts, ends };
}

function generateCandidates(source, options = {}) {
  const map = canonicalizeWithMap(source), proposed = [];
  const headingMatches = [];
  for (const [domain, pattern] of HEADINGS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(map.text); match; match = pattern.exec(map.text)) headingMatches.push({ domain, start: match.index, contentStart: match.index + match[0].length });
  }
  headingMatches.sort((a, b) => a.start - b.start);
  const covered = [];
  for (let i = 0; i < headingMatches.length; i += 1) {
    const heading = headingMatches[i], recognizedEnd = headingMatches[i + 1]?.start ?? map.text.length;
    const tail = map.text.slice(heading.contentStart, recognizedEnd), generic = /(?:^|\s)([A-Z][A-Z0-9 /&()'_-]{3,})\s*:/g;
    const genericMatch = generic.exec(tail);
    const end = genericMatch ? heading.contentStart + genericMatch.index + (genericMatch[0].startsWith(" ") ? 1 : 0) : recognizedEnd;
    covered.push({ start: heading.start, end });
    const section = map.text.slice(heading.contentStart, end);
    for (const span of splitSection(section, heading.contentStart)) proposed.push(makeCandidate(map, heading.domain, span.start, span.end, "section_entry"));
  }
  for (const span of splitGlobal(map.text)) {
    const midpoint = (span.start + span.end) / 2;
    if (covered.some((range) => midpoint >= range.start && midpoint < range.end)) continue;
    const value = map.text.slice(span.start, span.end);
    for (const [domain, cue] of Object.entries(CUES)) if (cue.test(value)) proposed.push(makeCandidate(map, domain, span.start, span.end, "cue_chunk"));
  }
  const deduped = [], seen = new Set();
  for (const candidate of proposed) {
    const key = `${candidate.domain_hint}|${normalize(candidate.canonical_text)}`;
    if (!candidate.canonical_text || candidate.canonical_text.length < 3 || seen.has(key)) continue;
    seen.add(key); deduped.push(candidate);
  }
  const maxTotal = Number(options.maxTotal || 160), maxPerDomain = Number(options.maxPerDomain || 70), counts = {}, selected = [], overflow = [];
  for (const candidate of deduped) {
    counts[candidate.domain_hint] = counts[candidate.domain_hint] || 0;
    if (selected.length >= maxTotal || counts[candidate.domain_hint] >= maxPerDomain) overflow.push(candidate);
    else { counts[candidate.domain_hint] += 1; selected.push(candidate); }
  }
  assignStableIds(selected);
  return { version: "candidate-first-index-v1", canonical_text_sha256: sha256(map.text), candidates: selected, overflow: { count: overflow.length, by_domain: countBy(overflow.map((x) => x.domain_hint)) }, detected_domains: Object.fromEntries(Object.keys(CUES).map((domain) => [domain, selected.some((x) => x.domain_hint === domain)])) };
}

function splitSection(value, offset) {
  const markers = [...value.matchAll(/(?:^|\s)(?:\?{3,}|\d{1,2}[.)]|[-*])\s+/g)];
  if (!markers.length) return splitGlobal(value).map((x) => ({ start: offset + x.start, end: offset + x.end }));
  const spans = [];
  for (let i = 0; i < markers.length; i += 1) {
    let localStart = markers[i].index + (markers[i][0].match(/^\s/) ? 1 : 0);
    const placeholder = value.slice(localStart).match(/^\?{3,}\s*/);
    if (placeholder) localStart += placeholder[0].length;
    const start = offset + localStart, end = offset + (markers[i + 1]?.index ?? value.length);
    if (end > start) spans.push({ start, end });
  }
  return spans;
}

function splitGlobal(value) {
  const boundaries = [0];
  const regex = /(?:[.!?](?=\s+[A-Z\[])|(?=\s\d{1,2}[.)]\s+))/g;
  for (let match = regex.exec(value); match; match = regex.exec(value)) {
    boundaries.push(match.index + (match[0].startsWith(".") || match[0].startsWith("!") || match[0].startsWith("?") ? 1 : 0));
    if (!match[0].length) regex.lastIndex = match.index + 1;
  }
  boundaries.push(value.length);
  const spans = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    let start = boundaries[i], end = boundaries[i + 1];
    while (value[start] === " ") start += 1;
    while (value[end - 1] === " ") end -= 1;
    if (end > start && end - start <= 700) spans.push({ start, end });
    else if (end - start > 700) for (let cursor = start; cursor < end; cursor += 500) spans.push({ start: cursor, end: Math.min(end, cursor + 600) });
  }
  return spans;
}

function makeCandidate(map, domain, canonicalStart, canonicalEnd, origin) {
  while (map.text[canonicalStart] === " ") canonicalStart += 1;
  while (map.text[canonicalEnd - 1] === " ") canonicalEnd -= 1;
  const originalStart = map.starts[canonicalStart] ?? 0, originalEnd = map.ends[canonicalEnd - 1] ?? originalStart;
  return { candidate_id: null, domain_hint: domain, origin, canonical_start: canonicalStart, canonical_end: canonicalEnd, original_start: originalStart, original_end: originalEnd, canonical_text: map.text.slice(canonicalStart, canonicalEnd), source_quote: map.source.slice(originalStart, originalEnd) };
}

function assignStableIds(candidates) {
  const occurrences = new Map();
  for (const candidate of candidates) {
    const base = `C_${candidate.domain_hint.slice(0, 3).toUpperCase()}_${sha256(`${candidate.domain_hint}|${normalize(candidate.canonical_text)}`).slice(0, 12)}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    candidate.candidate_id = occurrence === 1 ? base : `${base}_${occurrence}`;
  }
}
function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function countBy(values) { return Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((x) => x === value).length])); }

module.exports = { canonicalizeWithMap, generateCandidates };
