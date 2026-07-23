#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readRows } = require("./adapt-aci-bench");
const { scoreAciNoteGeneration } = require("./score-aci-note-generation");
const { scoreAciNoteFactuality } = require("./score-aci-note-factuality");

const DEFAULT_METHODS = ["drop_unsupported", "replace_unsupported", "compact_extractive", "guided_extractive"];

function parseArgs(argv) {
  const args = {
    out: "results/aci-note-attribution-repair.json",
    split: "unknown",
    "prediction-field": "generated_note",
    "repaired-field": "repaired_note",
    methods: DEFAULT_METHODS.join(","),
    "min-overlap": "0.28",
    "backfill-budget": "prediction_plus_15pct",
    "bootstrap-repeats": "1000",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function evaluateAciNoteAttributionRepair(rows, options = {}) {
  const split = options.split || "unknown";
  const predictionField = options.predictionField || options["prediction-field"] || "generated_note";
  const repairedField = options.repairedField || options["repaired-field"] || "repaired_note";
  const methods = methodList(options.methods);
  const minOverlap = numberOption(options.minOverlap ?? options["min-overlap"], 0.28);
  const bootstrapRepeats = numberOption(options.bootstrapRepeats ?? options["bootstrap-repeats"], 1000);
  const beforeRows = rows.filter((row) => firstValue(row, [predictionField]));
  const before = {
    rouge: scoreAciNoteGeneration(beforeRows, { split, predictionField, bootstrapRepeats }).summary,
    source_support: scoreAciNoteFactuality(beforeRows, { split, predictionField }).summary,
    attribution: summarizeOriginalAttribution(beforeRows, { predictionField, minOverlap }),
  };

  const reports = {};
  for (const method of methods) {
    const repairedRows = repairAciNoteAttributionRows(beforeRows, {
      method,
      predictionField,
      repairedField,
      minOverlap,
      backfillBudget: options.backfillBudget || options["backfill-budget"] || "prediction_plus_15pct",
    });
    const repairSummary = summarizeRepair(repairedRows);
    const rougeSummary = scoreAciNoteGeneration(repairedRows, { split, predictionField: repairedField, bootstrapRepeats }).summary;
    const sourceSupportSummary = scoreAciNoteFactuality(repairedRows, { split, predictionField: repairedField }).summary;
    reports[method] = {
      description: methodDescription(method),
      records: repairedRows,
      summary: {
        repair: repairSummary,
        rouge: rougeSummary,
        source_support: sourceSupportSummary,
        tradeoff: summarizeRepairTradeoff(before, {
          rouge: rougeSummary,
          source_support: sourceSupportSummary,
        }),
      },
    };
  }

  const ranking = Object.entries(reports)
    .map(([method, report]) => ({
      method,
      rouge1_f1: report.summary.rouge.metrics.rouge1.f1,
      rouge2_f1: report.summary.rouge.metrics.rouge2.f1,
      rougeL_f1: report.summary.rouge.metrics.rougeL.f1,
      scored_case_rate: ratio(report.summary.source_support.cases, before.source_support.cases),
      source_token_support_rate: report.summary.source_support.mean_source_token_support_rate,
      source_bigram_support_rate: report.summary.source_support.mean_source_bigram_support_rate,
      unsupported_sentence_case_rate: ratio(report.summary.source_support.cases_with_unsupported_sentences, report.summary.source_support.cases),
      unsupported_sentence_case_rate_reduction: report.summary.tradeoff.unsupported_sentence_case_rate_reduction,
      rougeL_retention_rate: report.summary.tradeoff.rougeL_retention_rate,
      mean_repaired_tokens: report.summary.source_support.mean_prediction_tokens,
      token_yield_rate: ratio(report.summary.source_support.mean_prediction_tokens, before.source_support.mean_prediction_tokens),
      token_balance_score: tokenBalanceScore(ratio(report.summary.source_support.mean_prediction_tokens, before.source_support.mean_prediction_tokens)),
    }))
    .sort((left, right) => (
      (right.scored_case_rate - left.scored_case_rate)
      || (right.token_balance_score - left.token_balance_score)
      || (right.rougeL_retention_rate - left.rougeL_retention_rate)
      || (right.unsupported_sentence_case_rate_reduction - left.unsupported_sentence_case_rate_reduction)
      || (right.source_bigram_support_rate - left.source_bigram_support_rate)
      || (right.rouge2_f1 - left.rouge2_f1)
    ));

  return {
    generated_at: new Date().toISOString(),
    schema_version: "aci-note-attribution-repair-v1",
    split,
    prediction_field: predictionField,
    repaired_field: repairedField,
    configuration: {
      min_overlap: minOverlap,
      backfill_budget: options.backfillBudget || options["backfill-budget"] || "prediction_plus_15pct",
      methods,
    },
    before,
    methods: reports,
    ranking,
    selected_method: ranking[0]?.method || null,
    selection_rule: "Rank by scored-case rate, token-balance score, ROUGE-L retention, unsupported-sentence case-rate reduction, source-bigram support, then ROUGE-2 F1. Source-token support is retained as a gate-style lexical diagnostic, not the primary contribution, because source-span repair makes high token support expected by construction.",
    interpretation: "Deterministic attribution-repair diagnostic. The repair uses generated notes as salience queries and emits only source-dialogue text spans. The meaningful trade-off is ROUGE retention and unsupported-sentence reduction under source-span constraints; high lexical source support does not prove semantic factuality.",
  };
}

function repairAciNoteAttributionRows(rows, options = {}) {
  const method = options.method || "guided_extractive";
  const predictionField = options.predictionField || "generated_note";
  const repairedField = options.repairedField || "repaired_note";
  const minOverlap = numberOption(options.minOverlap, 0.28);
  return rows.map((row, rowIndex) => {
    const recordId = String(firstValue(row, ["record_id", "case_id", "encounter_id", "dialogue_id", "id", "file"]) || `row-${rowIndex + 1}`);
    const source = firstValue(row, ["source_text", "src", "dialogue", "conversation", "transcript", "input", "text"]);
    const prediction = firstValue(row, [predictionField]);
    const repair = repairNote({ source, prediction, method, minOverlap, backfillBudget: options.backfillBudget });
    return {
      ...row,
      [repairedField]: repair.text,
      attribution_repair: {
        schema_version: "aci-note-attribution-repair-v1",
        method,
        record_id: recordId,
        prediction_field: predictionField,
        repaired_field: repairedField,
        min_overlap: minOverlap,
        original_sentence_count: repair.original_sentence_count,
        repaired_sentence_count: repair.repaired_sentence_count,
        dropped_sentence_count: repair.dropped_sentence_count,
        replaced_sentence_count: repair.replaced_sentence_count,
        backfilled_sentence_count: repair.backfilled_sentence_count,
        evidence_atoms: repair.evidence_atoms,
        caveat: "Source-span repair is a lexical attribution control. It improves auditability but can produce less polished dialogue-derived notes.",
      },
    };
  });
}

function repairNote({ source, prediction, method, minOverlap, backfillBudget }) {
  const sourceSegments = sourceCandidates(source);
  const useCompactCandidates = method === "compact_extractive";
  const generatedSentences = splitSentences(prediction);
  const normalizedSource = normalizeForSubstring(source);
  const selected = [];
  const selectedKeys = new Set();
  const evidenceAtoms = [];
  let dropped = 0;
  let replaced = 0;

  generatedSentences.forEach((sentence, index) => {
    const normalizedSentence = normalizeForSubstring(sentence);
    const exact = normalizedSentence && normalizedSource.includes(normalizedSentence);
    if (method === "drop_unsupported") {
      if (exact) {
        pushSelected(selected, selectedKeys, { text: sentence, source_index: null, score: 1, origin: "generated_exact" });
        evidenceAtoms.push(atom(index, sentence, sentence, "extractive_supported", 1));
      } else {
        dropped += 1;
        evidenceAtoms.push(atom(index, sentence, "", "dropped_low_support", 0));
      }
      return;
    }

    if (exact && method === "replace_unsupported") {
      pushSelected(selected, selectedKeys, { text: sentence, source_index: null, score: 1, origin: "generated_exact" });
      evidenceAtoms.push(atom(index, sentence, sentence, "extractive_supported", 1));
      return;
    }

    const best = bestSourceCandidate(sentence, sourceSegments, { compact: useCompactCandidates });
    if (best && best.score >= minOverlap) {
      pushSelected(selected, selectedKeys, { ...best, origin: "source_replacement" });
      replaced += exact ? 0 : 1;
      evidenceAtoms.push(atom(index, sentence, best.text, exact ? "source_normalized" : "source_replaced", best.score));
    } else {
      dropped += 1;
      evidenceAtoms.push(atom(index, sentence, "", "dropped_low_support", best?.score || 0));
    }
  });

  let backfilled = 0;
  if (method === "guided_extractive") {
    const budget = repairedTokenBudget(prediction, backfillBudget);
    for (const candidate of rankBackfillCandidates(sourceSegments, prediction)) {
      if (tokenCount(joinSelected([...selected, candidate])) > budget) continue;
      if (pushSelected(selected, selectedKeys, { ...candidate, origin: "source_backfill" })) {
        backfilled += 1;
      }
      if (tokenCount(joinSelected(selected)) >= budget * 0.95) break;
    }
  }

  return {
    text: joinSelected(selected),
    original_sentence_count: generatedSentences.length,
    repaired_sentence_count: selected.length,
    dropped_sentence_count: dropped,
    replaced_sentence_count: replaced,
    backfilled_sentence_count: backfilled,
    evidence_atoms: evidenceAtoms,
  };
}

function sourceCandidates(source) {
  const marked = String(source || "")
    .replace(/\r/g, "\n")
    .replace(/\s+(?=(?:doctor|patient|clinician|provider|nurse|speaker\s*\d+|dr\.?)\s*:)/gi, "\n");
  const base = marked
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((item) => item.trim())
    .filter((item) => tokenCount(item) >= 3);
  const candidates = [];
  base.forEach((text, index) => {
    candidates.push({ text, source_index: index, score: 0 });
    if (base[index + 1] && tokenCount(`${text} ${base[index + 1]}`) <= 80) {
      candidates.push({ text: `${text} ${base[index + 1]}`, source_index: index, source_span: [index, index + 1], score: 0 });
    }
  });
  return candidates;
}

function bestSourceCandidate(query, candidates, options = {}) {
  let best = null;
  for (const candidate of candidates) {
    const score = candidateScore(query, candidate.text);
    if (!best || score > best.score) best = { ...candidate, score };
  }
  if (!best || !options.compact) return best;
  return compactBestCandidate(query, best);
}

function candidateScore(query, candidate) {
  const queryTokens = contentTokens(query);
  const candidateTokens = contentTokens(candidate);
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  const querySet = new Set(queryTokens);
  const overlap = [...querySet].filter((token) => candidateSet.has(token)).length;
  const queryCoverage = overlap / querySet.size;
  const candidatePrecision = overlap / candidateSet.size;
  const bigramCoverage = overlapRatio(ngrams(queryTokens, 2), new Set(ngrams(candidateTokens, 2)));
  const numbers = numbersIn(query);
  const numberCoverage = numbers.length ? overlapRatio(numbers, new Set(numbersIn(candidate))) : 1;
  const clinicalBoost = Math.min(0.12, clinicalCueScore(candidate) * 0.015);
  const numberPenalty = numberCoverage < 1 ? 0.20 : 0;
  return (0.58 * queryCoverage) + (0.24 * candidatePrecision) + (0.18 * bigramCoverage) + clinicalBoost - numberPenalty;
}

function rankBackfillCandidates(candidates, generatedNote) {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      score: (0.65 * candidateScore(generatedNote, candidate.text)) + (0.35 * Math.min(1, clinicalCueScore(candidate.text) / 4)),
    }))
    .filter((candidate) => candidate.score > 0.12)
    .sort((left, right) => (right.score - left.score) || (left.source_index - right.source_index));
}

function compactBestCandidate(query, candidate) {
  const queryTokenCount = tokenCount(query);
  const maxTokens = Math.max(8, Math.min(48, Math.ceil(queryTokenCount * 1.35)));
  const variants = compactCandidateVariants(candidate.text, query, maxTokens);
  let best = { ...candidate };
  for (const variant of variants) {
    const score = candidateScore(query, variant.text);
    if (
      !best
      || score > best.score
      || (score >= best.score - 0.04 && tokenCount(variant.text) < tokenCount(best.text))
    ) {
      best = { ...candidate, text: variant.text, score, compacted: true };
    }
  }
  return best;
}

function compactCandidateVariants(text, query, maxTokens) {
  const out = [];
  const stripped = stripSpeakerPrefix(text);
  const add = (value) => {
    const cleaned = String(value || "").trim();
    const count = tokenCount(cleaned);
    if (count >= 3 && count <= maxTokens) out.push({ text: cleaned });
  };
  add(stripped);
  for (const clause of stripped.split(/(?:[.;]|\s+-\s+|,\s+|\s+\band\b\s+|\s+\bbut\b\s+)/i)) add(clause);

  const tokenValues = tokens(stripped);
  const querySet = new Set(contentTokens(query));
  const anchors = tokenValues
    .map((token, index) => ({ token, index }))
    .filter((item) => querySet.has(item.token))
    .map((item) => item.index);
  const windowSizes = uniqueNumbers([
    Math.max(6, Math.ceil(maxTokens * 0.55)),
    Math.max(8, Math.ceil(maxTokens * 0.8)),
    maxTokens,
  ]);
  for (const anchor of anchors) {
    for (const size of windowSizes) {
      const start = Math.max(0, anchor - Math.floor(size / 2));
      const end = Math.min(tokenValues.length, start + size);
      add(tokenValues.slice(start, end).join(" "));
    }
  }
  return dedupeBy(out, (item) => normalizeForSubstring(item.text));
}

function summarizeOriginalAttribution(rows, options) {
  const sentences = rows.flatMap((row, rowIndex) => {
    const source = firstValue(row, ["source_text", "src", "dialogue", "conversation", "transcript", "input", "text"]);
    const prediction = firstValue(row, [options.predictionField]);
    const candidates = sourceCandidates(source);
    const normalizedSource = normalizeForSubstring(source);
    return splitSentences(prediction).map((sentence, sentenceIndex) => {
      const best = bestSourceCandidate(sentence, candidates);
      const exact = normalizedSource.includes(normalizeForSubstring(sentence));
      const weak = !exact && (!best || best.score < options.minOverlap);
      return {
        row_index: rowIndex,
        sentence_index: sentenceIndex,
        exact,
        best_score: best?.score || 0,
        weak_or_unsupported: weak,
        high_risk: isHighRiskSentence(sentence),
      };
    });
  });
  return {
    sentences: sentences.length,
    exact_supported_sentences: sentences.filter((item) => item.exact).length,
    weak_or_unsupported_sentences: sentences.filter((item) => item.weak_or_unsupported).length,
    proxy_overstatement_rate: rate(sentences, (item) => item.weak_or_unsupported),
    high_risk_weak_or_unsupported_sentences: sentences.filter((item) => item.weak_or_unsupported && item.high_risk).length,
    high_risk_proxy_overstatement_rate: rate(sentences.filter((item) => item.high_risk), (item) => item.weak_or_unsupported),
    mean_best_source_overlap: mean(sentences.map((item) => item.best_score)),
    caveat: "This is a lexical-source proxy over generated-note sentences. Weak overlap is not proof of hallucination, but it identifies claims that need attribution repair or review.",
  };
}

function summarizeRepair(rows) {
  const repairs = rows.map((row) => row.attribution_repair).filter(Boolean);
  return {
    records: repairs.length,
    original_sentences: sum(repairs.map((item) => item.original_sentence_count)),
    repaired_sentences: sum(repairs.map((item) => item.repaired_sentence_count)),
    dropped_sentences: sum(repairs.map((item) => item.dropped_sentence_count)),
    replaced_sentences: sum(repairs.map((item) => item.replaced_sentence_count)),
    backfilled_sentences: sum(repairs.map((item) => item.backfilled_sentence_count)),
    mean_repaired_sentences_per_record: mean(repairs.map((item) => item.repaired_sentence_count)),
  };
}

function summarizeRepairTradeoff(before, after) {
  const beforeUnsupportedCaseRate = ratio(
    before.source_support.cases_with_unsupported_sentences,
    before.source_support.cases,
  );
  const afterUnsupportedCaseRate = ratio(
    after.source_support.cases_with_unsupported_sentences,
    after.source_support.cases,
  );
  const beforeRougeL = before.rouge.metrics.rougeL.f1;
  const afterRougeL = after.rouge.metrics.rougeL.f1;
  const beforeTokens = before.source_support.mean_prediction_tokens;
  const afterTokens = after.source_support.mean_prediction_tokens;
  return {
    scored_case_rate: ratio(after.source_support.cases, before.source_support.cases),
    rouge1_retention_rate: ratio(after.rouge.metrics.rouge1.f1, before.rouge.metrics.rouge1.f1),
    rouge2_retention_rate: ratio(after.rouge.metrics.rouge2.f1, before.rouge.metrics.rouge2.f1),
    rougeL_retention_rate: ratio(afterRougeL, beforeRougeL),
    rougeL_f1_delta: numericDelta(afterRougeL, beforeRougeL),
    unsupported_sentence_case_rate_before: beforeUnsupportedCaseRate,
    unsupported_sentence_case_rate_after: afterUnsupportedCaseRate,
    unsupported_sentence_case_rate_reduction: numericDelta(beforeUnsupportedCaseRate, afterUnsupportedCaseRate),
    source_token_support_delta: numericDelta(
      after.source_support.mean_source_token_support_rate,
      before.source_support.mean_source_token_support_rate,
    ),
    source_bigram_support_delta: numericDelta(
      after.source_support.mean_source_bigram_support_rate,
      before.source_support.mean_source_bigram_support_rate,
    ),
    token_yield_rate: ratio(afterTokens, beforeTokens),
    token_growth_rate: numericDelta(ratio(afterTokens, beforeTokens), 1),
    caveat: "Source-span repair makes high lexical source support expected. ROUGE retention, unsupported-sentence reduction, and token growth are the more informative repair trade-off metrics.",
  };
}

function pushSelected(selected, selectedKeys, candidate) {
  const key = normalizeForSubstring(candidate.text);
  if (!key || selectedKeys.has(key)) return false;
  selected.push(candidate);
  selectedKeys.add(key);
  return true;
}

function atom(index, generatedSentence, sourceText, supportClass, score) {
  return {
    atom_id: `sentence-${index + 1}`,
    generated_sentence: generatedSentence,
    selected_source_text: sourceText,
    support_class: supportClass,
    lexical_overlap_score: score,
  };
}

function repairedTokenBudget(prediction, mode) {
  const predictionTokens = tokenCount(prediction);
  if (mode === "prediction") return Math.max(1, predictionTokens);
  if (mode === "prediction_plus_25pct") return Math.max(1, Math.ceil(predictionTokens * 1.25));
  if (mode === "prediction_plus_15pct") return Math.max(1, Math.ceil(predictionTokens * 1.15));
  const numeric = Number(mode);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Math.max(1, Math.ceil(predictionTokens * 1.15));
}

function joinSelected(selected) {
  return selected
    .sort((left, right) => (left.source_index ?? 1e9) - (right.source_index ?? 1e9))
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
}

function methodList(value) {
  if (Array.isArray(value)) return value;
  return String(value || DEFAULT_METHODS.join(",")).split(",").map((item) => item.trim()).filter(Boolean);
}

function methodDescription(method) {
  const descriptions = {
    drop_unsupported: "Keep only generated sentences that already occur lexically in the source dialogue.",
    replace_unsupported: "Replace each unsupported generated sentence with its best-matching source dialogue span; drop low-overlap sentences.",
    compact_extractive: "Replace generated sentences with compact source-token spans centered on overlapping clinical content; drop low-overlap sentences.",
    guided_extractive: "Use the generated note as a salience plan, select best-matching source spans, then backfill high-cue source spans up to a prediction-derived token budget.",
  };
  return descriptions[method] || "Undocumented attribution repair method.";
}

function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clinicalCueScore(text) {
  const normalized = normalize(text);
  let score = 0;
  for (const pattern of [
    /\bstart(?:ed)?\b/, /\bstop(?:ped)?\b/, /\bdiscontinue(?:d)?\b/, /\bcontinue(?:d)?\b/,
    /\bmedication\b/, /\bdose\b/, /\bmg\b/, /\bfollow\s?up\b/, /\bappointment\b/,
    /\breturn\b/, /\bcall\b/, /\bmonitor\b/, /\bcheck\b/, /\brepeat\b/, /\blab\b/,
    /\bcreatinine\b/, /\bpotassium\b/, /\bglucose\b/, /\bdiagnos(?:is|ed)\b/,
    /\bassessment\b/, /\bplan\b/, /\bdischarge\b/, /\bct\b/, /\bmri\b/, /\bxray\b/,
    /\bultrasound\b/, /\becho\b/, /\bprocedure\b/,
  ]) {
    if (pattern.test(normalized)) score += 1;
  }
  return score;
}

function isHighRiskSentence(text) {
  return /\b(?:warfarin|heparin|enoxaparin|apixaban|rivaroxaban|insulin|opioid|antibiotic|creatinine|potassium|inr|culture|biopsy|pathology|pending|return|call|follow.?up|monitor|bleeding|oxygen|dialysis|dose|mg)\b/i.test(String(text || ""));
}

function contentTokens(text) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "was", "were", "are", "you", "your", "will", "should", "doctor", "patient", "clinician", "provider"]);
  return tokens(text).filter((token) => token.length >= 3 && !stop.has(token));
}

function tokens(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || [];
}

function tokenCount(text) {
  return tokens(text).length;
}

function ngrams(values, n) {
  const out = [];
  for (let index = 0; index <= values.length - n; index += 1) out.push(values.slice(index, index + n).join(" "));
  return out;
}

function numbersIn(text) {
  return String(text || "").match(/\b\d+(?:\.\d+)?\b/g) || [];
}

function overlapRatio(values, targetSet) {
  if (!values.length) return 0;
  return values.filter((item) => targetSet.has(item)).length / values.length;
}

function normalize(text) {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeForSubstring(text) {
  return tokens(text).join(" ");
}

function stripSpeakerPrefix(text) {
  return String(text || "").replace(/^\s*(?:doctor|patient|clinician|provider|nurse|speaker\s*\d+|dr\.?)\s*:\s*/i, "").trim();
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))].sort((left, right) => left - right);
}

function dedupeBy(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && String(row[key]).trim()) return row[key];
  }
  const lower = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    if (lower[key] !== undefined && String(lower[key]).trim()) return lower[key];
  }
  return "";
}

function readInputRows(inputPath) {
  const text = fs.readFileSync(inputPath, "utf8").replace(/^\uFEFF/, "");
  const payload = JSON.parse(text);
  if (Array.isArray(payload?.records)) return payload.records;
  return readRows(inputPath);
}

function numberOption(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }
function numericDelta(after, before) {
  return Number.isFinite(after) && Number.isFinite(before) ? after - before : null;
}
function tokenBalanceScore(tokenYieldRate) {
  if (!Number.isFinite(tokenYieldRate) || tokenYieldRate <= 0) return 0;
  return Math.min(tokenYieldRate, 1 / tokenYieldRate);
}
function rate(rows, predicate) { return rows.length ? rows.filter(predicate).length / rows.length : null; }
function mean(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length ? nums.reduce((total, value) => total + value, 0) / nums.length : null;
}
function sum(values) {
  return values.filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input || args.records;
  if (!input) {
    console.error("--input or --records is required");
    process.exit(1);
  }
  const report = evaluateAciNoteAttributionRepair(readInputRows(input), {
    split: args.split,
    predictionField: args["prediction-field"],
    repairedField: args["repaired-field"],
    methods: args.methods,
    minOverlap: args["min-overlap"],
    backfillBudget: args["backfill-budget"],
    bootstrapRepeats: args["bootstrap-repeats"],
  });
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    split: report.split,
    before: {
      rouge1_f1: report.before.rouge.metrics.rouge1.f1,
      rouge2_f1: report.before.rouge.metrics.rouge2.f1,
      rougeL_f1: report.before.rouge.metrics.rougeL.f1,
      source_token_support_rate: report.before.source_support.mean_source_token_support_rate,
      source_bigram_support_rate: report.before.source_support.mean_source_bigram_support_rate,
      proxy_overstatement_rate: report.before.attribution.proxy_overstatement_rate,
    },
    ranking: report.ranking,
    selected_method: report.selected_method,
    selected_tradeoff: report.selected_method ? report.methods[report.selected_method].summary.tradeoff : null,
  }, null, 2));
}

if (require.main === module) main();
module.exports = {
  evaluateAciNoteAttributionRepair,
  repairAciNoteAttributionRows,
  repairNote,
  candidateScore,
};
