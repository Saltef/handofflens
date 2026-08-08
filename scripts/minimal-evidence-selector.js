const { buildSpanIndex } = require("./span-index");
const { contentTokens, expandKnownTerms } = require("./typed-provenance");
const { hasAssertionCueConflict } = require("./assertion-cue-scope");
const { isBudgetNormalizedLabelRiskUnion } = require("./run-decomposition-stress-experiment");

function selectMinimalEvidence(sourceText, item, options = {}) {
  const maxSpans = Number(options.maxSpans || 3);
  const quoteThreshold = Number(options.quoteThreshold || 0.72);
  const labelThreshold = Number(options.labelThreshold || 0.72);
  const minCandidateScore = Number(options.minCandidateScore || 0.08);
  const index = options.spanIndex || buildSpanIndex(sourceText, {
    granularity: options.granularity || "clause",
    sectionLexicon: options.sectionLexicon,
  });
  const task = normalizeTask(item);
  const quoteTokens = unique(contentTokens(expandKnownTerms(task.source_quote)));
  const labelTokens = unique(contentTokens(expandKnownTerms(task.label)));
  const targetTokens = unique([...quoteTokens, ...labelTokens]);
  const candidates = rankCandidateSpans(index.spans, task)
    .filter((span) => span.score >= minCandidateScore)
    .slice(0, Number(options.candidateLimit || 60));

  const selected = [];
  const covered = new Set();
  const rejected = [];

  for (let step = 0; step < maxSpans; step += 1) {
    const next = chooseNextSpan(candidates, selected, covered, targetTokens, task, rejected);
    if (!next) break;
    selected.push(next);
    for (const token of targetTokens) if (next.token_set.has(token)) covered.add(token);
    const current = evaluateSelection(selected, task, quoteThreshold, labelThreshold);
    if (current.supported) return finalizeSelection("supported", selected, current, rejected, index);
  }

  const final = evaluateSelection(selected, task, quoteThreshold, labelThreshold);
  const supportStatus = selected.length ? "insufficient_evidence" : "not_found";
  return finalizeSelection(supportStatus, selected, final, rejected, index);
}

function normalizeTask(item) {
  const label = String(item?.label || item?.normalized_value || item?.field || "");
  const sourceQuote = String(item?.source_quote || item?.sourceQuote || item?.quote || label);
  return {
    label,
    source_quote: sourceQuote,
    assertion: item?.assertion || "present",
    domain: item?.domain || item?.field || "unknown",
  };
}

function rankCandidateSpans(spans, task) {
  const quoteTokens = contentTokens(expandKnownTerms(task.source_quote));
  const labelTokens = contentTokens(expandKnownTerms(task.label));
  const quoteNorm = normalizeAggressive(task.source_quote);
  const labelNorm = normalizeAggressive(task.label);
  return spans.map((span, index) => {
    const tokenSet = new Set(contentTokens(expandKnownTerms(span.text)));
    const quoteCoverage = tokenSetCoverage(quoteTokens, tokenSet);
    const labelCoverage = tokenSetCoverage(labelTokens, tokenSet);
    const normalized = normalizeAggressive(span.text);
    const exactPart = Boolean((quoteNorm && normalized.includes(quoteNorm)) || (labelNorm && normalized.includes(labelNorm)));
    const score = Math.max(quoteCoverage, labelCoverage * 0.95, exactPart ? 1 : 0);
    return {
      id: span.id,
      ordinal: index + 1,
      text: span.text,
      section: span.section || "unknown",
      token_set: tokenSet,
      quote_coverage: quoteCoverage,
      label_coverage: labelCoverage,
      exact_normalized_part: exactPart,
      score,
    };
  }).sort((left, right) => right.score - left.score
    || Number(right.exact_normalized_part) - Number(left.exact_normalized_part)
    || right.quote_coverage - left.quote_coverage
    || right.label_coverage - left.label_coverage
    || left.id.localeCompare(right.id));
}

function chooseNextSpan(candidates, selected, covered, targetTokens, task, rejected) {
  return candidates
    .filter((candidate) => !selected.some((span) => span.id === candidate.id))
    .map((candidate) => {
      const proposed = [...selected, candidate].sort((left, right) => left.ordinal - right.ordinal);
      const combined = combinedCoverage(proposed, task);
      const assertionConflict = hasAssertionCueConflict(proposed.map((span) => span.text).join(" "), task.label, task);
      const labelRisk = isBudgetNormalizedLabelRiskUnion(proposed, combined, "query_label_minimal_selector");
      const gain = tokenGain(candidate.token_set, targetTokens, covered);
      return {
        ...candidate,
        gain,
        gain_density: gain / Math.max(1, wordCount(candidate.text)),
        proposed,
        assertionConflict,
        labelRisk,
      };
    })
    .filter((candidate) => {
      if (candidate.gain <= 0) {
        rejected.push({ span_id: candidate.id, reason: "zero_token_gain" });
        return false;
      }
      if (candidate.assertionConflict) {
        rejected.push({ span_id: candidate.id, reason: "assertion_conflict" });
        return false;
      }
      if (candidate.labelRisk) {
        rejected.push({ span_id: candidate.id, reason: "label_risk" });
        return false;
      }
      return true;
    })
    .sort((left, right) => right.gain - left.gain
      || right.gain_density - left.gain_density
      || right.score - left.score
      || left.id.localeCompare(right.id))[0] || null;
}

function evaluateSelection(selected, task, quoteThreshold, labelThreshold) {
  const combined = combinedCoverage(selected, task);
  const assertionConflict = hasAssertionCueConflict(selected.map((span) => span.text).join(" "), task.label, task);
  const labelRisk = isBudgetNormalizedLabelRiskUnion(selected, combined, "query_label_minimal_selector");
  return {
    supported: selected.length > 0
      && !assertionConflict
      && !labelRisk
      && (combined.quote_coverage >= quoteThreshold || combined.label_coverage >= labelThreshold),
    assertion_conflict: assertionConflict,
    label_risk: labelRisk,
    combined_quote_coverage: round(combined.quote_coverage),
    combined_label_coverage: round(combined.label_coverage),
  };
}

function finalizeSelection(supportStatus, selected, evaluation, rejected, index) {
  const ordered = selected.slice().sort((left, right) => left.ordinal - right.ordinal);
  const spanMap = index.byId instanceof Map ? index.byId : new Map(index.spans.map((span) => [span.id, span]));
  return {
    support_status: supportStatus,
    supported: supportStatus === "supported",
    evidence_span_ids: supportStatus === "supported" ? ordered.map((span) => span.id) : ordered.map((span) => span.id),
    selected_span_count: ordered.length,
    selected_context_words: wordCount(ordered.map((span) => span.text).join(" ")),
    selected_spans: ordered.map((span) => {
      const original = spanMap.get(span.id);
      return {
        span_id: span.id,
        text: span.text,
        section: span.section,
        char_start: original?.char_start ?? null,
        char_end: original?.char_end ?? null,
        quote_coverage: round(span.quote_coverage),
        label_coverage: round(span.label_coverage),
        score: round(span.score),
      };
    }),
    ...evaluation,
    rejected_counts: countBy(rejected.map((item) => item.reason)),
  };
}

function combinedCoverage(spans, task) {
  const tokenSet = new Set(spans.flatMap((span) => [...(span.token_set || new Set(contentTokens(expandKnownTerms(span.text))))]));
  return {
    quote_coverage: tokenSetCoverage(contentTokens(expandKnownTerms(task.source_quote)), tokenSet),
    label_coverage: tokenSetCoverage(contentTokens(expandKnownTerms(task.label)), tokenSet),
  };
}

function tokenSetCoverage(tokens, tokenSet) {
  const uniqueTokens = unique(tokens);
  if (!uniqueTokens.length) return 0;
  let found = 0;
  for (const token of uniqueTokens) if (tokenSet.has(token)) found += 1;
  return found / uniqueTokens.length;
}

function tokenGain(tokenSet, tokens, covered) {
  let gain = 0;
  for (const token of tokens) if (!covered.has(token) && tokenSet.has(token)) gain += 1;
  return gain;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAggressive(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[\*\*[^\]]+\*\*\]/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(value) {
  return normalizeAggressive(value).split(/\s+/).filter(Boolean).length;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

module.exports = { selectMinimalEvidence, rankCandidateSpans };
