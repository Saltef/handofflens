const DEFAULT_SECTION_LEXICON = [
  { section: "medications", pattern: /\b(discharge medications|medications at home|admission medications|medications)\b/i },
  { section: "diagnoses", pattern: /\b(discharge diagnoses|diagnoses|assessment|impression)\b/i },
  { section: "labs", pattern: /\b(laboratory|labs|chemistry|cbc|results)\b/i },
  { section: "procedures_tests", pattern: /\b(procedure|operation|imaging|radiology|studies|tests)\b/i },
  { section: "follow_up_safety", pattern: /\b(follow-?up|follow up|discharge instructions|instructions|pending|plan)\b/i },
  { section: "course", pattern: /\b(hospital course|brief hospital course|history of present illness)\b/i },
];

function buildSpanIndex(sourceText, options = {}) {
  const source = String(sourceText || "");
  const granularity = options.granularity || "clause";
  if (!["clause", "sentence", "line"].includes(granularity)) {
    throw new Error(`Unsupported span granularity: ${granularity}`);
  }
  const sectionLexicon = options.sectionLexicon || DEFAULT_SECTION_LEXICON;
  const lineFragments = nonEmptyLines(source);
  const spans = [];
  let currentSection = null;

  for (const line of lineFragments) {
    const heading = detectSectionHeading(line.text, sectionLexicon);
    if (heading) currentSection = heading;
    const fragments = splitLine(line, granularity, sectionLexicon);
    for (const fragment of fragments) {
      const fragmentHeading = detectSectionHeading(fragment.text, sectionLexicon);
      if (fragmentHeading) currentSection = fragmentHeading;
      if (isHeadingOnly(fragment.text)) continue;
      spans.push({
        id: `S${spans.length + 1}`,
        text: fragment.text,
        char_start: fragment.char_start,
        char_end: fragment.char_end,
        section: currentSection,
        line: line.line,
      });
    }
  }

  const byId = new Map(spans.map((span) => [span.id, span]));
  return {
    version: "span-index-v1",
    granularity,
    source,
    spans,
    byId,
    render() {
      return spans.map((span) => `[${span.id}] ${span.text}`).join("\n");
    },
  };
}

function nonEmptyLines(source) {
  const out = [];
  let line = 1;
  const re = /[^\r\n]*/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const raw = match[0];
    if (raw.length) {
      const leftTrim = raw.match(/^\s*/)[0].length;
      const rightTrim = raw.match(/\s*$/)[0].length;
      const text = raw.slice(leftTrim, raw.length - rightTrim);
      if (text) {
        out.push({
          line,
          text,
          char_start: match.index + leftTrim,
          char_end: match.index + raw.length - rightTrim,
        });
      }
    }
    if (match.index + raw.length >= source.length) break;
    const nextChar = source[match.index + raw.length];
    if (nextChar === "\r" && source[match.index + raw.length + 1] === "\n") {
      re.lastIndex += 2;
    } else {
      re.lastIndex += 1;
    }
    line += 1;
  }
  return out;
}

function splitLine(line, granularity, sectionLexicon) {
  if (granularity === "line") return [line];
  const headingSplit = splitHeadingPrefix(line, sectionLexicon);
  const fragments = [];
  for (const piece of headingSplit) {
    if (granularity === "sentence") fragments.push(...splitByPattern(piece, /(?<=[.!?])\s+/g));
    else fragments.push(...splitClauses(piece));
  }
  return fragments.map(trimFragment).filter((item) => item.text);
}

function splitHeadingPrefix(line, sectionLexicon) {
  const text = line.text;
  const colon = text.indexOf(":");
  if (colon < 0 || colon > 70) return [line];
  const prefix = text.slice(0, colon + 1);
  if (!detectSectionHeading(prefix, sectionLexicon)) return [line];
  const rest = text.slice(colon + 1);
  const out = [{
    text: prefix,
    char_start: line.char_start,
    char_end: line.char_start + colon + 1,
    line: line.line,
  }];
  if (rest.trim()) {
    const leftTrim = rest.match(/^\s*/)[0].length;
    out.push({
      text: rest.slice(leftTrim),
      char_start: line.char_start + colon + 1 + leftTrim,
      char_end: line.char_end,
      line: line.line,
    });
  }
  return out;
}

function splitClauses(fragment) {
  const prefixBounded = splitAtClinicalPrefixes(fragment);
  return prefixBounded.flatMap((piece) => splitByPattern(piece, /\s+\/\s+|;\s*|\s+\|\s+|(?<=[.!?])\s+|,\s+(?=(?:and|but|with|without|then)\b)/gi));
}

function splitAtClinicalPrefixes(fragment) {
  const re = /\b(?:admission|discharge|follow-?up instructions?|medications? on admission|medications? on discharge|mri head|ct head|labs?|laboratory|imaging|procedure|procedures)\s*:/gi;
  const starts = [];
  let match;
  while ((match = re.exec(fragment.text)) !== null) {
    if (match.index > 0) starts.push(match.index);
  }
  if (!starts.length) return [fragment];
  const boundaries = [0, ...starts, fragment.text.length];
  const out = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    out.push({
      text: fragment.text.slice(start, end),
      char_start: fragment.char_start + start,
      char_end: fragment.char_start + end,
      line: fragment.line,
    });
  }
  return out;
}

function splitByPattern(fragment, pattern) {
  const out = [];
  let last = 0;
  let match;
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  while ((match = re.exec(fragment.text)) !== null) {
    const end = match.index;
    out.push({
      text: fragment.text.slice(last, end),
      char_start: fragment.char_start + last,
      char_end: fragment.char_start + end,
      line: fragment.line,
    });
    last = match.index + match[0].length;
  }
  out.push({
    text: fragment.text.slice(last),
    char_start: fragment.char_start + last,
    char_end: fragment.char_end,
    line: fragment.line,
  });
  return out;
}

function trimFragment(fragment) {
  const leftTrim = fragment.text.match(/^\s*/)[0].length;
  const rightTrim = fragment.text.match(/\s*$/)[0].length;
  return {
    ...fragment,
    text: fragment.text.slice(leftTrim, fragment.text.length - rightTrim),
    char_start: fragment.char_start + leftTrim,
    char_end: fragment.char_end - rightTrim,
  };
}

function detectSectionHeading(text, sectionLexicon = DEFAULT_SECTION_LEXICON) {
  const value = String(text || "").trim().replace(/:$/, "");
  if (!value) return null;
  for (const entry of sectionLexicon) {
    if (entry.pattern.test(value)) return entry.section;
  }
  return null;
}

function isHeadingOnly(text) {
  const value = String(text || "").trim();
  return value.endsWith(":") && value.split(/\s+/).length <= 8;
}

module.exports = { buildSpanIndex, DEFAULT_SECTION_LEXICON };
