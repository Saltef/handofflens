#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { flattenEvidence } = require("./analyze-lexical-overstatement");
const { indexSource } = require("./source-evidence-index");
const { expandKnownTerms } = require("./typed-provenance");

const CATEGORY_DEFINITIONS = {
  exact_contiguous: "The source_quote is found as a contiguous span after case/whitespace normalization.",
  missing_source_text: "The result cannot be checked because no source text was available for the row.",
  missing_quote: "The evidence item has no source_quote.",
  normalization_or_punctuation: "The quote fails strict matching, but an aggressive punctuation/de-identification normalization finds a contiguous span.",
  quote_terms_present_noncontiguous: "Most quote terms are present in the source, or the quote explicitly uses ellipsis, but the quoted string is not one contiguous source span.",
  high_overlap_pointer_drift: "The quote has high token overlap with the source but does not resolve contiguously; likely pointer drift, section-header/list formatting, or small edits.",
  label_supported_quote_unresolved: "The label terms appear in the source, but the attached quote does not locate them cleanly.",
  weak_overlap_needs_review: "Some label or quote terms appear in the source, but automated evidence is too weak for a stronger classification.",
  low_overlap_possible_fabrication: "Neither the quote nor the label is well supported lexically in the source; this is the strongest automated signal of possible fabrication.",
};

const STRICTNESS_OR_POINTER_CATEGORIES = new Set([
  "normalization_or_punctuation",
  "quote_terms_present_noncontiguous",
  "high_overlap_pointer_drift",
  "label_supported_quote_unresolved",
]);

const SPAN_SUPPORT_DEFINITIONS = {
  strict_exact_contiguous: "The original source_quote resolves exactly; deterministic span IDs are attached for audit.",
  normalized_single_span: "A single deterministic source span supports the item after punctuation/de-identification normalization.",
  single_span_recovered: "A single deterministic source span covers the quote or label terms even though the generated quote did not resolve exactly.",
  multi_span_recovered: "Two or more deterministic source spans jointly support a non-contiguous or composite claim.",
  label_span_recovered: "The label is found in a deterministic source span, but the generated quote remains unreliable.",
  abstain_missing_source_text: "No source text was available; the item should abstain or route for review.",
  abstain_missing_quote: "The item supplied no source_quote; the item should abstain or route for review.",
  abstain_weak_overlap: "A weak lexical signal exists, but not enough for deterministic span materialization.",
  abstain_low_overlap: "No reliable lexical support was found; this is the highest-priority possible-fabrication review bucket.",
};

const SPAN_SUPPORTED_STATUSES = new Set([
  "strict_exact_contiguous",
  "normalized_single_span",
  "single_span_recovered",
  "multi_span_recovered",
  "label_span_recovered",
]);

const args = parseArgs(process.argv.slice(2));

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-provenance-misses.json");
  const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = analyzeProvenanceMissTaxonomy(payload, {
    inputPath,
    casesPath: args.cases,
    sampleLimit: Number(args["sample-limit"] || 25),
    worstLimit: Number(args["worst-limit"] || 10),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdOutPath, renderMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}

function analyzeProvenanceMissTaxonomy(payload, options = {}) {
  const records = recordsFromPayload(payload, options);
  const cases = records.map((record) => analyzeRecord(record, options));
  const items = cases.flatMap((item) => item.items);
  const completed = cases.filter((item) => item.success);
  const exactItems = items.filter((item) => item.miss_category === "exact_contiguous");
  const exactMisses = items.filter((item) => item.strict_quote_found === false);
  const caseExactPasses = completed.filter((item) => item.evidence_items > 0 && item.exact_quote_miss_items === 0 && item.missing_quote_items === 0 && item.items_with_source_text === item.evidence_items);
  const strictnessOrPointer = exactMisses.filter((item) => STRICTNESS_OR_POINTER_CATEGORIES.has(item.miss_category));
  const possibleFabrication = exactMisses.filter((item) => item.miss_category === "low_overlap_possible_fabrication");
  const spanSupported = items.filter((item) => SPAN_SUPPORTED_STATUSES.has(item.span_support.status));
  const exactMissSpanSupported = exactMisses.filter((item) => SPAN_SUPPORTED_STATUSES.has(item.span_support.status));
  const spanAbstained = items.filter((item) => item.span_support.action === "abstain_needs_review");
  const spanCasePasses = completed.filter((item) => item.evidence_items > 0 && item.items_with_source_text === item.evidence_items && item.provenance_abstain_items === 0);

  return {
    generated_at: new Date().toISOString(),
    schema_version: "provenance-miss-taxonomy-v2",
    summary: {
      records: records.length,
      completed_records: completed.length,
      evidence_items: items.length,
      exact_quote_items: exactItems.length,
      exact_quote_item_rate: ratio(exactItems.length, items.length),
      exact_quote_miss_items: exactMisses.length,
      missing_quote_items: items.filter((item) => item.miss_category === "missing_quote").length,
      exact_case_gate_passes: caseExactPasses.length,
      exact_case_gate_rate_among_completed: ratio(caseExactPasses.length, completed.length),
      miss_category_counts: countBy(items.map((item) => item.miss_category)),
      exact_miss_category_counts: countBy(exactMisses.map((item) => item.miss_category)),
      strictness_or_pointer_artifact_items: strictnessOrPointer.length,
      strictness_or_pointer_artifact_rate_among_exact_misses: ratio(strictnessOrPointer.length, exactMisses.length),
      possible_fabrication_items: possibleFabrication.length,
      possible_fabrication_rate_among_exact_misses: ratio(possibleFabrication.length, exactMisses.length),
      span_supported_items: spanSupported.length,
      span_supported_item_rate: ratio(spanSupported.length, items.length),
      span_case_gate_passes: spanCasePasses.length,
      span_case_gate_rate_among_completed: ratio(spanCasePasses.length, completed.length),
      exact_miss_span_supported_items: exactMissSpanSupported.length,
      exact_miss_span_supported_rate: ratio(exactMissSpanSupported.length, exactMisses.length),
      provenance_abstain_items: spanAbstained.length,
      provenance_abstain_rate_among_exact_misses: ratio(exactMisses.filter((item) => item.span_support.action === "abstain_needs_review").length, exactMisses.length),
      single_span_supported_items: spanSupported.filter((item) => item.span_support.evidence_mode === "single_span").length,
      multi_span_supported_items: spanSupported.filter((item) => item.span_support.evidence_mode === "multi_span").length,
      entailment_ready_items: spanSupported.filter((item) => item.span_support.entailment_input?.status === "ready_for_entailment_scorer").length,
      span_support_status_counts: countBy(items.map((item) => item.span_support.status)),
    },
    category_definitions: CATEGORY_DEFINITIONS,
    span_support_definitions: SPAN_SUPPORT_DEFINITIONS,
    data_parameter_buckets: summarizeDataParameterBuckets(cases),
    lowest_performing_cases: lowestPerformingCases(cases, options.worstLimit || 10),
    cases,
    samples: exactMisses.slice(0, options.sampleLimit || 25).map(sampleItem),
    interpretation: "Automated diagnostic for exact-source-provenance misses. It preserves the strict exact-span gate, then tests whether deterministic span IDs can recover auditable single-span or multi-span support. Abstain buckets and low-overlap labels are triage signals, not clinical factuality, hallucination, or entailment ground truth.",
  };
}

function recordsFromPayload(payload, options = {}) {
  if (Array.isArray(payload.records)) {
    return payload.records.map((record) => ({ ...record, success: record.success !== false }));
  }
  if (!Array.isArray(payload.results)) return [];
  const casesById = loadCasesById(options.casesPath || payload.cases_path, options.inputPath);
  return payload.results.map((result) => {
    const testCase = casesById.get(String(result.case_id || ""));
    return {
      ...result,
      success: !result.error && Boolean(result.extraction),
      source_text: result.source_text || result.discharge_summary || testCase?.discharge_summary || "",
      case: testCase || null,
    };
  });
}

function analyzeRecord(record) {
  const sourceText = getSourceText(record);
  const candidateIndex = buildCandidateSpanIndex(sourceText);
  const rawItems = flattenEvidence(record.extraction || {});
  const items = rawItems.map((item) => {
    const diagnosis = diagnoseEvidenceItem({
      sourceText,
      label: item.label,
      sourceQuote: item.source_quote,
      pathValue: item.path,
    });
    const spanSupport = proposeSpanSupport({
      candidateIndex,
      diagnosis,
      label: item.label,
      pathValue: item.path,
      sourceQuote: item.source_quote,
    });
    return {
      case_id: String(record.case_id || ""),
      path: item.path,
      domain: broadDomain(item.path),
      label: String(item.label || ""),
      source_quote: String(item.source_quote || ""),
      ...diagnosis,
      span_support: spanSupport,
    };
  });
  return {
    case_id: String(record.case_id || ""),
    success: Boolean(record.success),
    source_word_count: wordCount(sourceText),
    source_line_count: candidateIndex.segments.length,
    evidence_items: items.length,
    items_with_source_text: items.filter((item) => item.has_source_text).length,
    exact_quote_items: items.filter((item) => item.miss_category === "exact_contiguous").length,
    exact_quote_miss_items: items.filter((item) => item.strict_quote_found === false).length,
    missing_quote_items: items.filter((item) => item.miss_category === "missing_quote").length,
    span_supported_items: items.filter((item) => SPAN_SUPPORTED_STATUSES.has(item.span_support.status)).length,
    provenance_abstain_items: items.filter((item) => item.span_support.action === "abstain_needs_review").length,
    exact_quote_item_rate: ratio(items.filter((item) => item.miss_category === "exact_contiguous").length, items.length),
    span_supported_item_rate: ratio(items.filter((item) => SPAN_SUPPORTED_STATUSES.has(item.span_support.status)).length, items.length),
    miss_category_counts: countBy(items.map((item) => item.miss_category)),
    span_support_status_counts: countBy(items.map((item) => item.span_support.status)),
    items,
  };
}

function diagnoseEvidenceItem({ sourceText, label, sourceQuote, pathValue }) {
  const quote = String(sourceQuote || "");
  const labelText = String(label || "");
  const source = String(sourceText || "");
  const hasSourceText = Boolean(source.trim());
  const hasQuote = Boolean(quote.trim());
  const quoteNorm = normalizeExact(quote);
  const sourceNorm = normalizeExact(source);
  const quoteStrong = normalizeAggressive(quote);
  const sourceStrong = normalizeAggressive(source);
  const quoteTokens = contentTokens(quote);
  const labelTokens = contentTokens(expandKnownTerms(labelText));
  const quoteTokenCoverage = tokenCoverage(quoteTokens, sourceStrong);
  const labelTokenCoverage = tokenCoverage(labelTokens, sourceStrong);
  const hasEllipsis = /\.\.\.|\u2026/.test(quote);

  if (!hasSourceText) {
    return diagnosis("missing_source_text", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (!hasQuote) {
    return diagnosis("missing_quote", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (quoteNorm && sourceNorm.includes(quoteNorm)) {
    return diagnosis("exact_contiguous", true, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (quoteStrong && sourceStrong.includes(quoteStrong)) {
    return diagnosis("normalization_or_punctuation", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (hasEllipsis || quoteTokenCoverage >= 0.92) {
    return diagnosis("quote_terms_present_noncontiguous", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (quoteTokenCoverage >= 0.72) {
    return diagnosis("high_overlap_pointer_drift", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (labelTokenCoverage >= 0.72) {
    return diagnosis("label_supported_quote_unresolved", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  if (quoteTokenCoverage >= 0.45 || labelTokenCoverage >= 0.45) {
    return diagnosis("weak_overlap_needs_review", false, {
      hasSourceText,
      hasQuote,
      quoteTokenCoverage,
      labelTokenCoverage,
      pathValue,
    });
  }
  return diagnosis("low_overlap_possible_fabrication", false, {
    hasSourceText,
    hasQuote,
    quoteTokenCoverage,
    labelTokenCoverage,
    pathValue,
  });
}

function proposeSpanSupport({ candidateIndex, diagnosis, label, sourceQuote, pathValue }) {
  if (!diagnosis.has_source_text) {
    return spanSupport("abstain_missing_source_text", "abstain_needs_review", [], { evidenceMode: "none", reason: "source text unavailable", label, pathValue });
  }
  if (!diagnosis.has_quote) {
    return spanSupport("abstain_missing_quote", "abstain_needs_review", [], { evidenceMode: "none", reason: "source_quote unavailable", label, pathValue });
  }

  const quoteTokens = contentTokens(expandKnownTerms(sourceQuote));
  const labelTokens = contentTokens(expandKnownTerms(label));
  const ranked = rankCandidateSpans(candidateIndex, { quoteTokens, labelTokens, sourceQuote, label });
  const best = ranked[0];
  const quoteParts = splitQuoteParts(sourceQuote);
  const partSpans = uniqueSpans(quoteParts
    .map((part) => rankCandidateSpans(candidateIndex, {
      quoteTokens: contentTokens(expandKnownTerms(part)),
      labelTokens: [],
      sourceQuote: part,
      label: "",
    })[0])
    .filter((span) => span && (span.quote_coverage >= 0.72 || span.exact_normalized_part)));

  if (diagnosis.miss_category === "exact_contiguous") {
    return spanSupport("strict_exact_contiguous", "materialize_from_span_ids", best ? [best] : [], {
      evidenceMode: "single_span",
      reason: "original quote already resolved exactly",
      label,
      pathValue,
    });
  }

  if (quoteParts.length > 1 && partSpans.length > 1) {
    return spanSupport("multi_span_recovered", "materialize_from_span_ids", partSpans, {
      evidenceMode: "multi_span",
      reason: "quote decomposes into multiple supported source spans",
      label,
      pathValue,
    });
  }

  if (diagnosis.miss_category === "normalization_or_punctuation" && best && best.score >= 0.72) {
    return spanSupport("normalized_single_span", "materialize_from_span_ids", [best], {
      evidenceMode: "single_span",
      reason: "normalization resolves to one source span",
      label,
      pathValue,
    });
  }

  if (["quote_terms_present_noncontiguous", "high_overlap_pointer_drift"].includes(diagnosis.miss_category)
    && best && (best.quote_coverage >= 0.72 || best.label_coverage >= 0.72 || best.score >= 0.76)) {
    return spanSupport("single_span_recovered", "materialize_from_span_ids", [best], {
      evidenceMode: "single_span",
      reason: "deterministic source span covers quote or label terms",
      label,
      pathValue,
    });
  }

  if (diagnosis.miss_category === "label_supported_quote_unresolved" && best && best.label_coverage >= 0.72) {
    return spanSupport("label_span_recovered", "materialize_from_span_ids", [best], {
      evidenceMode: "single_span",
      reason: "label terms are anchored, but generated quote should be replaced",
      label,
      pathValue,
    });
  }

  if (diagnosis.miss_category === "low_overlap_possible_fabrication") {
    return spanSupport("abstain_low_overlap", "abstain_needs_review", best ? [best] : [], {
      evidenceMode: "none",
      reason: "no reliable lexical support for quote or label",
      label,
      pathValue,
    });
  }

  return spanSupport("abstain_weak_overlap", "abstain_needs_review", best ? [best] : [], {
    evidenceMode: "none",
    reason: "insufficient support for deterministic materialization",
    label,
    pathValue,
  });
}

function spanSupport(status, action, spans, details = {}) {
  const selected = spans.slice(0, details.evidenceMode === "multi_span" ? 4 : 1).map((span) => ({
    span_id: span.id,
    text: truncate(span.text, 240),
    quote_coverage: round(span.quote_coverage),
    label_coverage: round(span.label_coverage),
    score: round(span.score),
  }));
  return {
    status,
    action,
    evidence_mode: details.evidenceMode || "none",
    reason: details.reason || "",
    span_ids: selected.map((span) => span.span_id),
    selected_spans: selected,
    entailment_input: SPAN_SUPPORTED_STATUSES.has(status)
      ? {
        status: "ready_for_entailment_scorer",
        premise_span_ids: selected.map((span) => span.span_id),
        hypothesis: String(details.label || ""),
        path: String(details.pathValue || ""),
      }
      : {
        status: "not_ready_abstain",
        premise_span_ids: selected.map((span) => span.span_id),
        hypothesis: String(details.label || ""),
        path: String(details.pathValue || ""),
      },
  };
}

function diagnosis(missCategory, strictQuoteFound, details) {
  return {
    strict_quote_found: strictQuoteFound,
    miss_category: missCategory,
    has_source_text: details.hasSourceText,
    has_quote: details.hasQuote,
    quote_token_coverage_in_source: round(details.quoteTokenCoverage),
    label_token_coverage_in_source: round(details.labelTokenCoverage),
  };
}

function loadCasesById(casesPath, inputPath) {
  const out = new Map();
  const resolved = resolveCasesPath(casesPath, inputPath);
  if (!resolved) return out;
  const cases = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(cases)) return out;
  for (const testCase of cases) out.set(String(testCase.case_id || ""), testCase);
  return out;
}

function resolveCasesPath(casesPath, inputPath) {
  if (!casesPath) return null;
  const candidates = [];
  if (path.isAbsolute(casesPath)) candidates.push(casesPath);
  else {
    candidates.push(path.resolve(process.cwd(), casesPath));
    if (inputPath) candidates.push(path.resolve(path.dirname(inputPath), casesPath));
    if (inputPath) candidates.push(path.resolve(path.dirname(inputPath), "..", "..", casesPath));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getSourceText(record) {
  return String(record.source_text || record.source || record.discharge_summary || record.case?.discharge_summary || "");
}

function broadDomain(pathValue) {
  const value = String(pathValue || "");
  if (value.startsWith("medication_changes")) return "medication";
  if (value.startsWith("diagnosis_changes")) return "diagnosis";
  if (value.startsWith("procedures_and_tests")) return "procedure_or_test";
  if (value.startsWith("labs")) return "lab";
  if (value.startsWith("follow_up_actions")) return "follow_up";
  if (value.startsWith("safety_flags")) return "safety";
  if (value.startsWith("uncertain_items")) return "uncertain";
  if (value.startsWith("handoff_atoms")) return "atom";
  return "other";
}

function buildCandidateSpanIndex(sourceText) {
  const index = indexSource(sourceText);
  return {
    ...index,
    segments: index.segments.map((segment) => {
      const normalized = normalizeAggressive(segment.text);
      const tokens = contentTokens(segment.text);
      return {
        ...segment,
        normalized,
        token_set: new Set(tokens),
      };
    }),
  };
}

function rankCandidateSpans(candidateIndex, { quoteTokens, labelTokens, sourceQuote, label }) {
  const quoteStrong = normalizeAggressive(sourceQuote);
  const labelStrong = normalizeAggressive(label);
  return candidateIndex.segments.map((segment) => {
    const quoteCoverage = tokenSetCoverage(quoteTokens, segment.token_set);
    const labelCoverage = tokenSetCoverage(labelTokens, segment.token_set);
    const exactQuotePart = Boolean(quoteStrong && segment.normalized.includes(quoteStrong));
    const exactLabelPart = Boolean(labelStrong && segment.normalized.includes(labelStrong));
    const score = Math.max(
      quoteCoverage,
      labelCoverage * 0.95,
      exactQuotePart ? 1 : 0,
      exactLabelPart ? 0.92 : 0
    );
    return {
      id: segment.id,
      text: segment.text,
      quote_coverage: quoteCoverage,
      label_coverage: labelCoverage,
      exact_normalized_part: exactQuotePart || exactLabelPart,
      score,
    };
  }).sort((left, right) => right.score - left.score
    || Number(right.exact_normalized_part) - Number(left.exact_normalized_part)
    || right.quote_coverage - left.quote_coverage
    || right.label_coverage - left.label_coverage
    || left.id.localeCompare(right.id));
}

function splitQuoteParts(sourceQuote) {
  return String(sourceQuote || "")
    .split(/\.\.\.|\u2026|\r?\n/)
    .map((part) => part.trim())
    .filter((part) => contentTokens(part).length > 0);
}

function uniqueSpans(spans) {
  const seen = new Set();
  const out = [];
  for (const span of spans) {
    if (!span || seen.has(span.id)) continue;
    seen.add(span.id);
    out.push(span);
  }
  return out;
}

function normalizeExact(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
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

function contentTokens(value) {
  const stop = new Set([
    "the",
    "was",
    "were",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "patient",
    "discharge",
    "discharged",
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
    "admission",
    "admitted",
    "medication",
    "medications",
    "diagnosis",
    "diagnoses",
    "hospital",
    "course",
    "brief",
    "follow",
    "up",
    "sig",
  ]);
  return normalizeAggressive(value)
    .split(/\s+/)
    .map((token) => (/^\d+(?:\.\d+)?$/.test(token) ? token : token.replace(/\.+$/g, "")))
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function tokenCoverage(tokens, sourceStrong) {
  const unique = [...new Set(tokens)];
  if (!unique.length) return 0;
  const sourceTokens = new Set(
    sourceStrong
      .split(/\s+/)
      .map((token) => (/^\d+(?:\.\d+)?$/.test(token) ? token : token.replace(/\.+$/g, "")))
      .filter(Boolean)
  );
  let found = 0;
  for (const token of unique) if (sourceTokens.has(token)) found += 1;
  return found / unique.length;
}

function tokenSetCoverage(tokens, tokenSet) {
  const unique = [...new Set(tokens)];
  if (!unique.length) return 0;
  let found = 0;
  for (const token of unique) if (tokenSet.has(token)) found += 1;
  return found / unique.length;
}

function wordCount(value) {
  return normalizeAggressive(value).split(/\s+/).filter(Boolean).length;
}

function summarizeDataParameterBuckets(cases) {
  return {
    source_word_count: summarizeBuckets(cases, sourceWordBucket),
    source_line_count: summarizeBuckets(cases, sourceLineBucket),
    evidence_item_count: summarizeBuckets(cases, evidenceItemBucket),
  };
}

function summarizeBuckets(cases, bucketFn) {
  const buckets = {};
  for (const testCase of cases.filter((item) => item.success && item.evidence_items > 0)) {
    const bucket = bucketFn(testCase);
    if (!buckets[bucket]) {
      buckets[bucket] = {
        records: 0,
        evidence_items: 0,
        exact_quote_items: 0,
        exact_quote_miss_items: 0,
        span_supported_items: 0,
        provenance_abstain_items: 0,
      };
    }
    buckets[bucket].records += 1;
    buckets[bucket].evidence_items += testCase.evidence_items;
    buckets[bucket].exact_quote_items += testCase.exact_quote_items;
    buckets[bucket].exact_quote_miss_items += testCase.exact_quote_miss_items;
    buckets[bucket].span_supported_items += testCase.span_supported_items;
    buckets[bucket].provenance_abstain_items += testCase.provenance_abstain_items;
  }
  return Object.fromEntries(Object.entries(buckets).map(([bucket, values]) => [bucket, {
    ...values,
    exact_quote_item_rate: ratio(values.exact_quote_items, values.evidence_items),
    span_supported_item_rate: ratio(values.span_supported_items, values.evidence_items),
    provenance_abstain_item_rate: ratio(values.provenance_abstain_items, values.evidence_items),
  }]));
}

function sourceWordBucket(testCase) {
  const value = testCase.source_word_count;
  if (value < 1000) return "<1000";
  if (value < 2000) return "1000-1999";
  if (value < 4000) return "2000-3999";
  return "4000+";
}

function sourceLineBucket(testCase) {
  const value = testCase.source_line_count;
  if (value < 50) return "<50";
  if (value < 100) return "50-99";
  if (value < 200) return "100-199";
  return "200+";
}

function evidenceItemBucket(testCase) {
  const value = testCase.evidence_items;
  if (value < 15) return "<15";
  if (value < 30) return "15-29";
  if (value < 50) return "30-49";
  return "50+";
}

function lowestPerformingCases(cases, limit) {
  return cases
    .filter((item) => item.success && item.evidence_items > 0)
    .sort((left, right) => left.exact_quote_item_rate - right.exact_quote_item_rate || right.exact_quote_miss_items - left.exact_quote_miss_items)
    .slice(0, limit)
    .map((item) => ({
      case_id: item.case_id,
      source_word_count: item.source_word_count,
      source_line_count: item.source_line_count,
      evidence_items: item.evidence_items,
      exact_quote_items: item.exact_quote_items,
      exact_quote_item_rate: item.exact_quote_item_rate,
      exact_quote_miss_items: item.exact_quote_miss_items,
      span_supported_items: item.span_supported_items,
      span_supported_item_rate: item.span_supported_item_rate,
      provenance_abstain_items: item.provenance_abstain_items,
      dominant_miss_category: dominantCategory(item.miss_category_counts, "exact_contiguous"),
      dominant_span_support_status: dominantCategory(item.span_support_status_counts),
    }));
}

function dominantCategory(counts, exclude) {
  return Object.entries(counts || {})
    .filter(([category]) => category !== exclude)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || "";
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function sampleItem(item) {
  return {
    case_id: item.case_id,
    path: item.path,
    domain: item.domain,
    miss_category: item.miss_category,
    span_support_status: item.span_support.status,
    span_support_action: item.span_support.action,
    span_ids: item.span_support.span_ids,
    quote_token_coverage_in_source: item.quote_token_coverage_in_source,
    label_token_coverage_in_source: item.label_token_coverage_in_source,
    label: truncate(item.label, 180),
    source_quote: truncate(item.source_quote, 240),
  };
}

function truncate(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function renderMarkdown(report) {
  const lines = [
    "# Provenance Miss Taxonomy",
    "",
    report.interpretation,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Records | ${report.summary.records} |`,
    `| Completed records | ${report.summary.completed_records} |`,
    `| Evidence items | ${report.summary.evidence_items} |`,
    `| Exact contiguous quote items | ${report.summary.exact_quote_items} |`,
    `| Exact quote item rate | ${formatPercent(report.summary.exact_quote_item_rate)} |`,
    `| Exact case gate passes | ${report.summary.exact_case_gate_passes} |`,
    `| Exact case gate rate among completed | ${formatPercent(report.summary.exact_case_gate_rate_among_completed)} |`,
    `| Exact quote miss items | ${report.summary.exact_quote_miss_items} |`,
    `| Strictness/pointer artifact share among exact misses | ${formatPercent(report.summary.strictness_or_pointer_artifact_rate_among_exact_misses)} |`,
    `| Possible-fabrication share among exact misses | ${formatPercent(report.summary.possible_fabrication_rate_among_exact_misses)} |`,
    `| Span-supported items after deterministic recovery | ${report.summary.span_supported_items} |`,
    `| Span-supported item rate | ${formatPercent(report.summary.span_supported_item_rate)} |`,
    `| Span case gate passes | ${report.summary.span_case_gate_passes} |`,
    `| Span case gate rate among completed | ${formatPercent(report.summary.span_case_gate_rate_among_completed)} |`,
    `| Exact misses recovered to span IDs | ${report.summary.exact_miss_span_supported_items} |`,
    `| Exact-miss span recovery rate | ${formatPercent(report.summary.exact_miss_span_supported_rate)} |`,
    `| Provenance abstain items | ${report.summary.provenance_abstain_items} |`,
    `| Provenance abstain rate among exact misses | ${formatPercent(report.summary.provenance_abstain_rate_among_exact_misses)} |`,
    `| Single-span supported items | ${report.summary.single_span_supported_items} |`,
    `| Multi-span supported items | ${report.summary.multi_span_supported_items} |`,
    `| Entailment-ready items | ${report.summary.entailment_ready_items} |`,
    "",
    "## Exact-Miss Categories",
    "",
    "| Category | Items | Meaning |",
    "| --- | ---: | --- |",
  ];
  for (const [category, count] of Object.entries(report.summary.exact_miss_category_counts)) {
    lines.push(`| \`${category}\` | ${count} | ${CATEGORY_DEFINITIONS[category] || ""} |`);
  }
  lines.push("", "## Span-ID Support Status", "", "| Status | Items | Meaning |", "| --- | ---: | --- |");
  for (const [status, count] of Object.entries(report.summary.span_support_status_counts)) {
    lines.push(`| \`${status}\` | ${count} | ${SPAN_SUPPORT_DEFINITIONS[status] || ""} |`);
  }
  if (report.lowest_performing_cases.length) {
    lines.push("", "## Lowest Exact-Provenance Cases", "", "| Case | Source words | Lines | Items | Exact rate | Span-supported rate | Abstains | Dominant miss | Dominant span status |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
    for (const testCase of report.lowest_performing_cases) {
      lines.push(`| ${testCase.case_id} | ${testCase.source_word_count} | ${testCase.source_line_count} | ${testCase.evidence_items} | ${formatPercent(testCase.exact_quote_item_rate)} | ${formatPercent(testCase.span_supported_item_rate)} | ${testCase.provenance_abstain_items} | \`${testCase.dominant_miss_category}\` | \`${testCase.dominant_span_support_status}\` |`);
    }
  }
  lines.push("", "## Data Parameter Buckets");
  for (const [bucketName, buckets] of Object.entries(report.data_parameter_buckets)) {
    lines.push("", `### ${bucketName}`, "", "| Bucket | Records | Items | Exact rate | Span-supported rate | Abstain rate |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [bucket, values] of Object.entries(buckets)) {
      lines.push(`| \`${bucket}\` | ${values.records} | ${values.evidence_items} | ${formatPercent(values.exact_quote_item_rate)} | ${formatPercent(values.span_supported_item_rate)} | ${formatPercent(values.provenance_abstain_item_rate)} |`);
    }
  }
  if (report.samples.length) {
    lines.push("", "## Sample Misses", "", "| Case | Path | Category | Span support | Span IDs | Quote coverage | Label coverage | Label | Source quote |", "| --- | --- | --- | --- | --- | ---: | ---: | --- | --- |");
    for (const sample of report.samples) {
      lines.push(`| ${sample.case_id} | \`${sample.path}\` | \`${sample.miss_category}\` | \`${sample.span_support_status}\` | ${escapeTable(sample.span_ids.join(", "))} | ${format(sample.quote_token_coverage_in_source)} | ${format(sample.label_token_coverage_in_source)} | ${escapeTable(sample.label)} | ${escapeTable(sample.source_quote)} |`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatPercent(value) {
  return value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function format(value) {
  return value === null || value === undefined ? "N/A" : Number(value).toFixed(3);
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|");
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

module.exports = {
  analyzeProvenanceMissTaxonomy,
  diagnoseEvidenceItem,
  proposeSpanSupport,
  CATEGORY_DEFINITIONS,
  SPAN_SUPPORT_DEFINITIONS,
};
