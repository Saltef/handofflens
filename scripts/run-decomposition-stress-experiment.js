#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { indexSource } = require("./source-evidence-index");
const { analyzeProvenanceMissTaxonomy } = require("./analyze-provenance-miss-taxonomy");
const { contentTokens, expandKnownTerms } = require("./typed-provenance");
const { hasAssertionCueConflict } = require("./assertion-cue-scope");

const args = parseArgs(process.argv.slice(2));

const METHOD_DEFINITIONS = {
  exact_full_note: "Baseline exact contiguous quote search over the full source note; supported cases require full-note context.",
  normalized_full_note: "Aggressive punctuation/de-identification normalized quote search over the full source note; supported cases require full-note context.",
  line_span_id: "Best deterministic line/list span selected by quote and label token overlap.",
  section_filtered_span: "Domain-routed section/list candidate selection before span scoring.",
  query_aware_multispan: "Query-aware retrieval of one or more spans for non-contiguous or composite evidence, including clause-aware quote splitting and a bounded greedy token-union fallback.",
};

const METHOD_ORDER = Object.keys(METHOD_DEFINITIONS);

if (require.main === module) {
  const inputPath = required(args.input, "--input is required");
  const casesPath = required(args.cases, "--cases is required");
  const outPath = args.out || inputPath.replace(/\.json$/i, "-decomposition-stress.json");
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
  const report = runDecompositionStressExperiment(payload, {
    inputPath,
    cases,
    casesPath,
    taskLimit: Number(args["task-limit"] || 20),
    caseLimit: Number(args["case-limit"] || 20),
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(args.mdout || outPath.replace(/\.json$/i, ".md"), renderMarkdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
}

function runDecompositionStressExperiment(payload, options = {}) {
  const records = recordsFromPayload(payload, options);
  const taxonomy = analyzeProvenanceMissTaxonomy(payload, {
    inputPath: options.inputPath,
    casesPath: options.casesPath,
    sampleLimit: 0,
    worstLimit: options.caseLimit || 20,
  });
  const recordsById = new Map(records.map((record) => [String(record.case_id || ""), record]));
  const tasks = selectStressTasks(taxonomy, recordsById, options.taskLimit || 20);
  const taskResults = tasks.map((task) => runTask(task, recordsById.get(task.case_id)));
  const methodReports = METHOD_ORDER.map((method) => summarizeMethod(method, taskResults));

  return {
    generated_at: new Date().toISOString(),
    schema_version: "decomposition-stress-v1",
    task_selection: {
      task_limit: options.taskLimit || 20,
      case_limit: options.caseLimit || 20,
      policy: "Select failed exact-provenance evidence items from the lowest exact-provenance records, prioritizing abstain/low-overlap/weak-overlap cases before easier pointer artifacts.",
    },
    method_definitions: METHOD_DEFINITIONS,
    summary: {
      tasks: taskResults.length,
      source_records: new Set(taskResults.map((task) => task.case_id)).size,
      exact_baseline_supported_tasks: methodReports.find((item) => item.method === "exact_full_note")?.supported_tasks || 0,
      best_method: bestMethod(methodReports),
      methods: methodReports,
      dominant_task_miss_categories: countBy(taskResults.map((task) => task.miss_category)),
      task_domains: countBy(taskResults.map((task) => task.domain)),
    },
    tasks: taskResults,
    interpretation: "Stress diagnostic over low-performing evidence items. It compares deterministic parsing/chunking support policies against the same model-generated claims. Success means lexical/span support under that method, not semantic entailment, clinical factuality, or model correctness.",
  };
}

function recordsFromPayload(payload, options = {}) {
  const casesById = new Map((options.cases || []).map((testCase) => [String(testCase.case_id || ""), testCase]));
  if (Array.isArray(payload.records)) {
    return payload.records.map((record) => ({ ...record, success: record.success !== false }));
  }
  if (!Array.isArray(payload.results)) return [];
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

function selectStressTasks(taxonomy, recordsById, limit) {
  const lowestCases = taxonomy.lowest_performing_cases.map((item) => item.case_id);
  const priority = {
    abstain_low_overlap: 0,
    abstain_weak_overlap: 1,
    abstain_missing_quote: 2,
    label_span_recovered: 3,
    single_span_recovered: 4,
    multi_span_recovered: 5,
    normalized_single_span: 6,
  };
  const tasks = [];
  for (const caseId of lowestCases) {
    const caseReport = taxonomy.cases.find((item) => item.case_id === caseId);
    if (!caseReport || !recordsById.has(caseId)) continue;
    for (const item of caseReport.items) {
      if (item.strict_quote_found !== false) continue;
      tasks.push({
        case_id: caseId,
        path: item.path,
        domain: item.domain,
        label: item.label,
        source_quote: item.source_quote,
        miss_category: item.miss_category,
        prior_span_support_status: item.span_support?.status || "",
        prior_span_support_action: item.span_support?.action || "",
        source_word_count: caseReport.source_word_count,
        source_line_count: caseReport.source_line_count,
        case_exact_quote_item_rate: caseReport.exact_quote_item_rate,
      });
    }
  }
  return tasks
    .sort((left, right) => (priority[left.prior_span_support_status] ?? 50) - (priority[right.prior_span_support_status] ?? 50)
      || left.case_exact_quote_item_rate - right.case_exact_quote_item_rate
      || right.source_word_count - left.source_word_count
      || left.case_id.localeCompare(right.case_id)
      || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function runTask(task, record) {
  const sourceText = getSourceText(record);
  const context = buildContext(sourceText);
  const methodResults = Object.fromEntries(METHOD_ORDER.map((method) => [method, evaluateMethod(method, task, context)]));
  return {
    ...task,
    methods: methodResults,
  };
}

function evaluateMethod(method, task, context) {
  if (method === "exact_full_note") return exactFullNote(task, context);
  if (method === "normalized_full_note") return normalizedFullNote(task, context);
  if (method === "line_span_id") return lineSpanId(task, context);
  if (method === "section_filtered_span") return sectionFilteredSpan(task, context);
  if (method === "query_aware_multispan") return queryAwareMultiSpan(task, context);
  throw new Error(`Unknown method: ${method}`);
}

function exactFullNote(task, context) {
  const quote = normalizeExact(task.source_quote);
  const supported = Boolean(quote && context.source_exact.includes(quote));
  return result({
    supported,
    status: supported ? "exact_contiguous" : "abstain_exact_missing",
    spans: supported ? exactSpans(task, context, false) : [],
    method: "exact_full_note",
    contextWords: supported ? context.source_word_count : 0,
  });
}

function normalizedFullNote(task, context) {
  const quote = normalizeAggressive(task.source_quote);
  const supported = Boolean(quote && context.source_normalized.includes(quote));
  return result({
    supported,
    status: supported ? "normalized_contiguous" : "abstain_normalized_missing",
    spans: supported ? exactSpans(task, context, true) : [],
    method: "normalized_full_note",
    contextWords: supported ? context.source_word_count : 0,
  });
}

function lineSpanId(task, context) {
  const best = rankSegments(context.segments, task)[0];
  const supported = Boolean(best && (best.quote_coverage >= 0.72 || best.label_coverage >= 0.72 || best.exact_normalized_part));
  return result({ supported, status: supported ? "single_line_supported" : "abstain_line_weak", spans: best ? [best] : [], method: "line_span_id" });
}

function sectionFilteredSpan(task, context) {
  const candidates = context.segments.filter((segment) => isDomainRelevant(segment.section, task.domain));
  const fallback = context.segments.filter((segment) => segment.is_header);
  const ranked = rankSegments(candidates.length ? candidates : fallback, task);
  const best = ranked[0];
  const supported = Boolean(best && (best.quote_coverage >= 0.72 || best.label_coverage >= 0.72 || best.exact_normalized_part));
  return result({ supported, status: supported ? "section_supported" : "abstain_section_weak", spans: best ? [best] : [], method: "section_filtered_span" });
}

function queryAwareMultiSpan(task, context) {
  const lowOverlap = isLowOverlapTask(task);
  const parts = splitQuoteParts(task.source_quote);
  const spans = uniqueSpans(parts.flatMap((part) => {
    const ranked = rankSegments(context.segments, {
      ...task,
      source_quote: part,
      label: part,
    });
    return ranked.filter((span) => span.quote_coverage >= 0.72 || span.label_coverage >= 0.72 || span.exact_normalized_part).slice(0, 1);
  }));
  let combined = combinedCoverage(spans, task);
  let selected = spans;
  let status = selected.length > 1 ? "query_multispan_supported" : "query_single_span_supported";

  if (!querySupport(selected, combined)) {
    let greedy = greedyMultiSpan(task, context);
    let greedyStatus = "query_greedy";
    if (!greedy.supported) {
      const relaxedGreedy = greedyMultiSpan(task, context, relaxedGreedyMinimumScore(task));
      if (relaxedGreedy.supported) {
        greedy = relaxedGreedy;
        greedyStatus = "query_relaxed_greedy";
      }
    }
    if (greedy.supported) {
      selected = greedy.spans;
      combined = greedy.combined;
      status = selected.length > 1 ? `${greedyStatus}_multispan_supported` : `${greedyStatus}_single_span_supported`;
    }
  }

  const labelOnly = rankSegments(context.segments, task).filter((span) => span.label_coverage >= 0.72).slice(0, 2);
  if (!lowOverlap && !querySupport(selected, combined) && labelOnly.length) {
    selected = labelOnly;
    combined = combinedCoverage(selected, task);
    status = selected.length > 1 ? "query_label_multispan_supported" : "query_label_single_span_supported";
  }

  const assertionConflict = hasAssertionCueConflict(selected.map((span) => span.text).join(" "), task.label, task);
  const supported = !lowOverlap && !assertionConflict && querySupport(selected, combined);
  const unsupportedStatus = assertionConflict ? "abstain_query_assertion_conflict" : "abstain_query_weak";
  return result({
    supported,
    status: supported ? status : unsupportedStatus,
    spans: selected,
    method: "query_aware_multispan",
    combined,
  });
}

function isLowOverlapTask(task) {
  return task.prior_span_support_status === "abstain_low_overlap" || task.miss_category === "low_overlap_possible_fabrication";
}

function querySupport(spans, combined) {
  return Boolean(spans.length && (combined.quote_coverage >= 0.72 || combined.label_coverage >= 0.72));
}

function greedyMultiSpan(task, context, minimumScore = 0.16) {
  const quoteTokens = [...new Set(contentTokens(expandKnownTerms(task.source_quote)))];
  const labelTokens = [...new Set(contentTokens(expandKnownTerms(task.label)))];
  const targetTokens = [...new Set([...quoteTokens, ...labelTokens])];
  if (targetTokens.length < 2) {
    return { supported: false, spans: [], combined: { quote_coverage: 0, label_coverage: 0 } };
  }

  const selected = [];
  const covered = new Set();
  const ranked = rankSegments(context.segments, task)
    .filter((span) => span.score >= minimumScore)
    .slice(0, 40);

  for (let i = 0; i < 4; i += 1) {
    const next = ranked
      .filter((span) => !selected.some((item) => item.id === span.id))
      .map((span) => ({
        ...span,
        gain: tokenGain(span.token_set, targetTokens, covered),
        quote_gain: tokenGain(span.token_set, quoteTokens, covered),
      }))
      .filter((span) => span.gain > 0)
      .sort((left, right) => right.gain - left.gain
        || right.quote_gain - left.quote_gain
        || right.score - left.score
        || left.id.localeCompare(right.id))[0];
    if (!next) break;
    selected.push(next);
    for (const token of targetTokens) if (next.token_set.has(token)) covered.add(token);
  }

  const ordered = selected.sort((left, right) => left.ordinal - right.ordinal);
  const combined = combinedCoverage(ordered, task);
  const contextWords = wordCount(ordered.map((span) => span.text).join(" "));
  const spanWindow = ordered.length ? ordered[ordered.length - 1].ordinal - ordered[0].ordinal + 1 : 0;
  const strongQuote = combined.quote_coverage >= 0.86 && ordered.length > 1;
  const quoteAndLabel = combined.quote_coverage >= 0.78 && combined.label_coverage >= 0.5;
  const safeWindow = spanWindow <= 80 && contextWords <= 100;
  const lowOverlap = isLowOverlapTask(task);
  const supported = safeWindow && !lowOverlap && (strongQuote || quoteAndLabel);
  return { supported, spans: ordered, combined };
}

function relaxedGreedyMinimumScore(task) {
  const quoteTokens = [...new Set(contentTokens(expandKnownTerms(task.source_quote)))];
  return quoteTokens.length >= 16 ? 0.08 : 0.16;
}

function result({ supported, status, spans, method, combined, contextWords }) {
  const selected = (spans || []).slice(0, method === "query_aware_multispan" ? 4 : 1).map((span) => ({
    span_id: span.id,
    section: span.section,
    text: truncate(span.text, 220),
    quote_coverage: round(span.quote_coverage),
    label_coverage: round(span.label_coverage),
    score: round(span.score),
  }));
  return {
    supported: Boolean(supported),
    status,
    selected_span_count: selected.length,
    selected_context_words: contextWords ?? wordCount(selected.map((span) => span.text).join(" ")),
    selected_spans: selected,
    combined_quote_coverage: combined ? round(combined.quote_coverage) : round(Math.max(...selected.map((span) => span.quote_coverage), 0)),
    combined_label_coverage: combined ? round(combined.label_coverage) : round(Math.max(...selected.map((span) => span.label_coverage), 0)),
  };
}

function buildContext(sourceText) {
  const index = indexSource(sourceText);
  const sections = assignSections(index.segments);
  return {
    source_exact: normalizeExact(sourceText),
    source_normalized: normalizeAggressive(sourceText),
    source_word_count: wordCount(sourceText),
    segments: index.segments.map((segment) => {
      const section = sections.get(segment.id) || "unknown";
      const normalized = normalizeAggressive(segment.text);
      return {
        ...segment,
        section,
        ordinal: segment.ordinal,
        normalized,
        token_set: new Set(contentTokens(expandKnownTerms(segment.text))),
        is_header: isHeader(segment.text),
      };
    }),
  };
}

function assignSections(segments) {
  const out = new Map();
  let current = "unknown";
  for (const segment of segments) {
    if (isHeader(segment.text)) current = classifySection(segment.text);
    out.set(segment.id, current);
  }
  return out;
}

function classifySection(text) {
  const value = normalizeAggressive(text);
  if (/\b(discharge medications|medications at home|admission medications|medications)\b/.test(value)) return "medications";
  if (/\b(discharge diagnoses|diagnoses|assessment|impression)\b/.test(value)) return "diagnoses";
  if (/\b(laboratory|labs|chemistry|cbc|results)\b/.test(value)) return "labs";
  if (/\b(procedure|operation|imaging|radiology|studies|tests)\b/.test(value)) return "procedures_tests";
  if (/\b(follow up|followup|discharge instructions|instructions|pending|plan)\b/.test(value)) return "follow_up_safety";
  if (/\b(hospital course|brief hospital course|history of present illness)\b/.test(value)) return "course";
  return value.slice(0, 40) || "unknown";
}

function isHeader(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (/^[A-Z0-9 /\-(),]+:\s*$/.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z0-9 /\-(),]{2,45}:\s*$/.test(trimmed)) return true;
  return /^(?:DISCHARGE|ADMISSION|FOLLOW|HOSPITAL|BRIEF|LAB|MEDICATION|DIAGNOS|PROCEDURE|PLAN|INSTRUCTION)/i.test(trimmed) && trimmed.endsWith(":");
}

function isDomainRelevant(section, domain) {
  if (domain === "medication") return section === "medications" || section === "course";
  if (domain === "diagnosis") return section === "diagnoses" || section === "course";
  if (domain === "lab") return section === "labs" || section === "course";
  if (domain === "procedure_or_test") return section === "procedures_tests" || section === "course";
  if (domain === "follow_up" || domain === "safety") return section === "follow_up_safety" || section === "course";
  return true;
}

function rankSegments(segments, task) {
  const quoteTokens = contentTokens(expandKnownTerms(task.source_quote));
  const labelTokens = contentTokens(expandKnownTerms(task.label));
  const quoteNorm = normalizeAggressive(task.source_quote);
  const labelNorm = normalizeAggressive(task.label);
  return segments.map((segment) => {
    const quoteCoverage = tokenSetCoverage(quoteTokens, segment.token_set);
    const labelCoverage = tokenSetCoverage(labelTokens, segment.token_set);
    const exactPart = Boolean((quoteNorm && segment.normalized.includes(quoteNorm)) || (labelNorm && segment.normalized.includes(labelNorm)));
    const score = Math.max(quoteCoverage, labelCoverage * 0.95, exactPart ? 1 : 0);
    return {
      id: segment.id,
      ordinal: segment.ordinal,
      text: segment.text,
      section: segment.section,
      token_set: segment.token_set,
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

function exactSpans(task, context, aggressive) {
  const needle = aggressive ? normalizeAggressive(task.source_quote) : normalizeExact(task.source_quote);
  const key = aggressive ? "normalized" : "text";
  return context.segments
    .filter((segment) => (aggressive ? segment.normalized : normalizeExact(segment[key])).includes(needle))
    .map((segment) => ({
      ...segment,
      quote_coverage: 1,
      label_coverage: tokenSetCoverage(contentTokens(expandKnownTerms(task.label)), segment.token_set),
      score: 1,
    }));
}

function combinedCoverage(spans, task) {
  const tokenSet = new Set(spans.flatMap((span) => [...(span.token_set || new Set(contentTokens(expandKnownTerms(span.text))))]));
  return {
    quote_coverage: tokenSetCoverage(contentTokens(expandKnownTerms(task.source_quote)), tokenSet),
    label_coverage: tokenSetCoverage(contentTokens(expandKnownTerms(task.label)), tokenSet),
  };
}

function splitQuoteParts(sourceQuote) {
  const source = String(sourceQuote || "");
  const quoted = [...source.matchAll(/"([^"]{3,})"/g)].map((match) => match[1]);
  const structuralParts = source.split(/\.\.\.|\u2026|\r?\n|\s+\/\s+|(?=\b(?:admission|discharge|follow-?up instructions?|medications? on admission|medications? on discharge|mri head|ct head|labs?|laboratory|imaging|procedure|procedures)\s*:)/i);
  return uniqueStrings([...quoted, ...structuralParts])
    .map(stripQuoteSourcePrefix)
    .map((part) => part.trim())
    .filter((part) => contentTokens(part).length > 0);
}

function stripQuoteSourcePrefix(value) {
  return String(value || "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^(?:admission|discharge|follow-?up instructions?|medications? on admission|medications? on discharge|mri head|ct head|labs?|laboratory|imaging|procedure|procedures)\s*:\s*/i, "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeAggressive(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
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

function summarizeMethod(method, taskResults) {
  const results = taskResults.map((task) => task.methods[method]);
  const supported = results.filter((item) => item.supported);
  return {
    method,
    supported_tasks: supported.length,
    support_rate: ratio(supported.length, results.length),
    mean_selected_context_words: round(mean(results.map((item) => item.selected_context_words))),
    mean_selected_context_words_supported: round(mean(supported.map((item) => item.selected_context_words))),
    mean_selected_span_count: round(mean(results.map((item) => item.selected_span_count))),
    mean_selected_span_count_supported: round(mean(supported.map((item) => item.selected_span_count))),
    status_counts: countBy(results.map((item) => item.status)),
  };
}

function bestMethod(methodReports) {
  return [...methodReports].sort((left, right) => right.support_rate - left.support_rate
    || left.mean_selected_context_words_supported - right.mean_selected_context_words_supported
    || METHOD_ORDER.indexOf(left.method) - METHOD_ORDER.indexOf(right.method))[0] || null;
}

function renderMarkdown(report) {
  const lines = [
    "# Decomposition Stress Experiment",
    "",
    report.interpretation,
    "",
    "## Summary",
    "",
    `Tasks: ${report.summary.tasks}`,
    "",
    "| Method | Supported tasks | Support rate | Mean context words, supported | Mean spans, supported |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const method of report.summary.methods) {
    lines.push(`| \`${method.method}\` | ${method.supported_tasks} | ${formatPercent(method.support_rate)} | ${format(method.mean_selected_context_words_supported)} | ${format(method.mean_selected_span_count_supported)} |`);
  }
  lines.push("", "## Methods", "");
  for (const [method, definition] of Object.entries(report.method_definitions)) {
    lines.push(`- \`${method}\`: ${definition}`);
  }
  lines.push("", "## Task Mix", "", "| Category | Count |", "| --- | ---: |");
  for (const [category, count] of Object.entries(report.summary.dominant_task_miss_categories)) {
    lines.push(`| \`${category}\` | ${count} |`);
  }
  lines.push("", "## Task Results", "", "| Case | Path | Domain | Miss | Prior status | Exact | Normalized | Line | Section | Query/multispan |", "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const task of report.tasks) {
    lines.push(`| ${task.case_id} | \`${task.path}\` | ${task.domain} | \`${task.miss_category}\` | \`${task.prior_span_support_status}\` | ${bool(task.methods.exact_full_note.supported)} | ${bool(task.methods.normalized_full_note.supported)} | ${bool(task.methods.line_span_id.supported)} | ${bool(task.methods.section_filtered_span.supported)} | ${bool(task.methods.query_aware_multispan.supported)} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function getSourceText(record) {
  return String(record?.source_text || record?.source || record?.discharge_summary || record?.case?.discharge_summary || "");
}

function tokenSetCoverage(tokens, tokenSet) {
  const unique = [...new Set(tokens)];
  if (!unique.length) return 0;
  let found = 0;
  for (const token of unique) if (tokenSet.has(token)) found += 1;
  return found / unique.length;
}

function tokenGain(tokenSet, tokens, covered) {
  let gain = 0;
  for (const token of tokens) if (!covered.has(token) && tokenSet.has(token)) gain += 1;
  return gain;
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

function wordCount(value) {
  return normalizeAggressive(value).split(/\s+/).filter(Boolean).length;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function format(value) {
  return value === null || value === undefined ? "N/A" : Number(value).toFixed(1);
}

function formatPercent(value) {
  return value === null || value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`;
}

function bool(value) {
  return value ? "yes" : "no";
}

function truncate(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
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
  runDecompositionStressExperiment,
  evaluateMethod,
  METHOD_DEFINITIONS,
};
