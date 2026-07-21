#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = args.cases || "eval/clinician_review_50.json";
const outPath = args.out || "results/hybrid-safety-experiment.json";
const mdPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const alpha = Number(args.alpha || 0.10);
const confidence = Number(args.confidence || 0.95);
const repeats = Number(args.repeats || 200);
const pairs = parsePairs(args.pairs || [
  "results/cohere-review50.json::results/judge-cohere-review50-gpt5mini.json",
  "results/claude-haiku-45-review50.json::results/judge-claude-haiku-review50-gpt5mini.json"
].join(","));

const DOMAIN_RULES = [
  { name: "medication_list", source: /discharge medications|medications on admission|home medications|medications:/i, extraction: /medication|\bmg\b|\bmcg\b|tablet|capsule/ },
  { name: "anticoagulation_or_bleeding", source: /coumadin|warfarin|heparin|lovenox|enoxaparin|anticoag|bleed|hemorrhage|\binr\b|\bptt\b/i, extraction: /coumadin|warfarin|heparin|lovenox|enoxaparin|anticoag|bleed|hemorrhage|\binr\b|\bptt\b/ },
  { name: "infection_or_antibiotic", source: /vancomycin|zosyn|cef\w*|cipro|levofloxacin|azithro|flagyl|antibiotic|culture|bacter|sepsis|pneumonia|abscess/i, extraction: /vancomycin|zosyn|cef\w*|cipro|levofloxacin|azithro|flagyl|antibiotic|culture|bacter|sepsis|pneumonia|abscess/ },
  { name: "renal_or_dosing", source: /creatinine|renal|kidney|dialysis|\bbun\b|\bckd\b|\barf\b|\baki\b|nephro/i, extraction: /creatinine|renal|kidney|dialysis|\bbun\b|\bckd\b|\barf\b|\baki\b|nephro/ },
  { name: "respiratory_or_oxygen", source: /oxygen|intubat|ventilat|hypox|respiratory failure|\bpeep\b|trach|nasal cannula/i, extraction: /oxygen|intubat|ventilat|hypox|respiratory failure|\bpeep\b|trach|nasal cannula/ },
  { name: "wound_or_device", source: /wound|drain|foley|catheter|\bpicc\b|central line|tube|staple|suture|device|ostomy/i, extraction: /wound|drain|foley|catheter|\bpicc\b|central line|tube|staple|suture|device|ostomy/ },
  { name: "pending_or_follow_up", source: /follow.?up|appointment|clinic|\bpcp\b|pending|repeat|monitor/i, extraction: /follow.?up|appointment|clinic|\bpcp\b|pending|repeat|monitor/ },
  { name: "icu_or_goals", source: /\bicu\b|expired|death|comfort|withdraw|\bdnr\b|family meeting|pressor/i, extraction: /\bicu\b|expired|death|comfort|withdraw|\bdnr\b|family meeting|pressor/ }
];

const HIGH_RISK_DOMAINS = new Set(DOMAIN_RULES.map((rule) => rule.name));

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const rows = pairs.flatMap(({ resultsPath, judgmentsPath }) => loadRows(resultsPath, judgmentsPath));
const byModel = groupBy(rows, (row) => row.model);

const report = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  alpha,
  confidence,
  repeats,
  label_definition: "Unsafe proxy = blinded LLM judge handover_safety <= 1 or source_record_match <= 1.",
  caution: "This is an offline methods pilot using LLM-judge labels, not clinician-adjudicated clinical validity. Atomic checks are source-grounding heuristics and do not prove correctness.",
  models: {}
};

for (const [model, modelRows] of Object.entries(byModel)) {
  report.models[model] = evaluateModel(modelRows);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(mdPath, renderMarkdown(report));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdPath}`);

function loadRows(resultsPath, judgmentsPath) {
  const resultReport = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const judgmentReport = JSON.parse(fs.readFileSync(judgmentsPath, "utf8"));
  const resultsById = new Map((resultReport.results || []).map((item) => [item.case_id, item]));
  return (judgmentReport.judgments || []).map((entry) => {
    const result = resultsById.get(entry.case_id);
    const testCase = casesById.get(entry.case_id);
    if (!result || !testCase || !entry.judgment) return null;
    const verification = verifyExtraction(result, testCase);
    const after = entry.judgment.after_source_review || {};
    const safety = Number(after.handover_safety?.score);
    const match = Number(after.source_record_match?.score);
    return {
      case_id: entry.case_id,
      model: entry.actual_model || result.model || entry.judged_model,
      safety_score: safety,
      source_match_score: match,
      unsafe: safety <= 1 || match <= 1 ? 1 : 0,
      failure_modes: entry.judgment.failure_modes || [],
      verification,
      risk_score: verification.risk_score,
      risk_probability: verification.risk_score / (verification.risk_score + 12)
    };
  }).filter(Boolean);
}

function verifyExtraction(result, testCase) {
  const source = String(testCase.discharge_summary || "");
  const normalizedSource = normalize(source);
  const extraction = result.extraction || {};
  const claims = evidenceClaims(extraction).map((claim) => verifyClaim(claim, source, normalizedSource));
  const extractionText = normalize(JSON.stringify(extraction));
  const sourceDomains = detectDomains(source);
  const omissions = [];

  for (const domain of DOMAIN_RULES) {
    if (!sourceDomains[domain.name]) continue;
    if (!domain.extraction.test(extractionText)) omissions.push(domain.name);
  }

  const medicationClaims = claims.filter((claim) => claim.domain === "medication");
  if (sourceDomains.medication_list && medicationClaims.length === 0) omissions.push("medication_list");
  const summary = String(extraction.two_page_summary || "");
  const absoluteClaims = unsupportedAbsoluteClaims(summary, source);
  const unsupportedQuotes = claims.filter((claim) => claim.quote_status === "unsupported").length;
  const missingQuotes = claims.filter((claim) => claim.quote_status === "missing").length;
  const unsupportedRelations = claims.filter((claim) => claim.relationship_status === "unsupported").length;
  const numericMismatches = claims.filter((claim) => claim.numeric_status === "mismatch").length;
  const technicalFailure = Boolean(result.error || !summary.trim());
  const criticalOmissions = omissions.filter((name) => HIGH_RISK_DOMAINS.has(name));
  const riskScore =
    (technicalFailure ? 100 : 0) +
    Math.min(18, unsupportedQuotes * 3) +
    Math.min(12, missingQuotes * 2) +
    Math.min(20, unsupportedRelations * 4) +
    Math.min(12, numericMismatches * 4) +
    Math.min(24, criticalOmissions.length * 6) +
    Math.min(12, absoluteClaims.length * 4);

  return {
    technical_failure: technicalFailure,
    evidence_claim_count: claims.length,
    supported_quote_count: claims.filter((claim) => claim.quote_status === "supported").length,
    unsupported_quote_count: unsupportedQuotes,
    missing_quote_count: missingQuotes,
    unsupported_relationship_count: unsupportedRelations,
    numeric_mismatch_count: numericMismatches,
    omission_proxies: [...new Set(omissions)],
    critical_omission_count: criticalOmissions.length,
    unsupported_absolute_claims: absoluteClaims,
    quote_support_rate: claims.length ? claims.filter((claim) => claim.quote_status === "supported").length / claims.length : 0,
    hard_block: technicalFailure || criticalOmissions.length > 0 || unsupportedRelations > 0 || numericMismatches > 0,
    risk_score: riskScore,
    claims
  };
}

function detectDomains(source) {
  return Object.fromEntries(DOMAIN_RULES.map((rule) => [rule.name, rule.source.test(source)]));
}

function evidenceClaims(extraction) {
  const paths = [
    ["medication_changes.started", "medication", "started"],
    ["medication_changes.stopped", "medication", "stopped"],
    ["medication_changes.changed", "medication", "changed"],
    ["medication_changes.continued", "medication", "continued"],
    ["medication_changes.uncertain", "medication", "uncertain"],
    ["diagnosis_changes.discharge", "diagnosis", "discharge"],
    ["diagnosis_changes.new_or_changed", "diagnosis", "new_or_changed"],
    ["procedures_and_tests", "procedure_or_test", "performed"],
    ["labs", "lab", "reported"],
    ["follow_up_actions", "follow_up", "required"],
    ["safety_flags", "safety", "flagged"],
    ["uncertain_items", "uncertain", "uncertain"]
  ];
  return paths.flatMap(([dottedPath, domain, relationship]) => arrayAt(extraction, dottedPath).map((item) => ({
    path: dottedPath,
    domain,
    relationship,
    label: String(item.label || ""),
    rationale: String(item.rationale || ""),
    source_quote: String(item.source_quote || "")
  })));
}

function verifyClaim(claim, source, normalizedSource) {
  const quote = claim.source_quote.trim();
  const normalizedQuote = normalize(quote);
  let quoteStatus = "missing";
  let quoteIndex = -1;
  if (normalizedQuote) {
    quoteIndex = normalizedSource.indexOf(normalizedQuote);
    quoteStatus = quoteIndex >= 0 || tokenCoverage(normalizedQuote, normalizedSource) >= 0.92 ? "supported" : "unsupported";
  }
  const sourceIndex = quote ? source.toLowerCase().indexOf(quote.toLowerCase()) : -1;
  const context = sourceIndex >= 0 ? source.slice(Math.max(0, sourceIndex - 1200), sourceIndex + quote.length + 300) : quote;
  const relationshipStatus = verifyRelationship(claim, context);
  const labelNumbers = extractNumbers(claim.label);
  const contextNumbers = new Set(extractNumbers(`${quote} ${context}`));
  const numericStatus = labelNumbers.length && labelNumbers.some((value) => !contextNumbers.has(value)) ? "mismatch" : "supported_or_not_applicable";
  return {
    path: claim.path,
    domain: claim.domain,
    relationship: claim.relationship,
    label: claim.label,
    quote_status: quoteStatus,
    relationship_status: relationshipStatus,
    numeric_status: numericStatus
  };
}

function verifyRelationship(claim, context) {
  if (claim.domain !== "medication") return "not_applicable";
  const text = normalize(`${context} ${claim.source_quote}`);
  const cues = {
    started: /start|begin|initiated|added|new medication|prescribed|placed on|treated with/,
    stopped: /stop|discontinue|held|withheld|avoid|no longer|taken off/,
    changed: /increase|decrease|reduce|adjust|change|titrate|switch|replace/,
    continued: /continue|resume|remain on|maintain|discharge medications|medications at discharge/,
    uncertain: /uncertain|unclear|verify|reconcile|unknown/
  };
  return cues[claim.relationship]?.test(text) ? "supported" : "unsupported";
}

function unsupportedAbsoluteClaims(summary, source) {
  const risky = /\b(?:all|no other|none|resolved|stable|normal|no follow-up|required no|continued during hospitalization|unchanged)\b/i;
  return summary.split(/(?<=[.!?])\s+|\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 20 && risky.test(item))
    .filter((item) => tokenCoverage(normalize(item), normalize(source)) < 0.55)
    .slice(0, 10);
}

function evaluateModel(rows) {
  const unsafeCount = sum(rows.map((row) => row.unsafe));
  const fixed = {
    accept_all: evaluateDecisions(rows, () => true),
    quote_only: evaluateDecisions(rows, (row) => !row.verification.technical_failure && row.verification.missing_quote_count === 0 && row.verification.unsupported_quote_count === 0),
    atomic_hard_gate: evaluateDecisions(rows, (row) => !row.verification.hard_block && row.verification.risk_score <= 8)
  };
  const runs = [];
  for (let seed = 1; seed <= repeats; seed += 1) {
    const { calibration, test } = stratifiedSplit(rows, seed, 0.60);
    if (!calibration.length || !test.length) continue;
    const empiricalThreshold = selectRiskThreshold(calibration, alpha, { confidenceBound: false });
    const controlledThreshold = selectRiskThreshold(calibration, alpha, {
      confidenceBound: true,
      delta: 1 - confidence
    });
    const q = conformalQuantile(calibration.map((row) => nonconformity(row.risk_probability, row.unsafe)), alpha);
    runs.push({
      empirical_threshold: empiricalThreshold,
      controlled_threshold: controlledThreshold,
      empirical_score: evaluateDecisions(test, (row) => row.risk_score <= empiricalThreshold),
      risk_controlled_score: evaluateDecisions(test, (row) => row.risk_score <= controlledThreshold),
      split_conformal: evaluateDecisions(test, (row) => conformalLowRiskSingleton(row.risk_probability, q)),
      hybrid_split_conformal: evaluateDecisions(test, (row) => !row.verification.hard_block && conformalLowRiskSingleton(row.risk_probability, q))
    });
  }
  return {
    cases: rows.length,
    unsafe_proxy_cases: unsafeCount,
    unsafe_proxy_rate: unsafeCount / rows.length,
    mean_risk_score: mean(rows.map((row) => row.risk_score)),
    risk_score_auc: auc(rows.map((row) => ({ score: row.risk_score, event: row.unsafe === 1 }))),
    verification_summary: summarizeVerification(rows),
    signal_associations: signalAssociations(rows),
    fixed_methods: fixed,
    calibrated_methods: {
      empirical_score: aggregateRuns(runs, "empirical_score"),
      risk_controlled_score: aggregateRuns(runs, "risk_controlled_score"),
      split_conformal: aggregateRuns(runs, "split_conformal"),
      hybrid_split_conformal: aggregateRuns(runs, "hybrid_split_conformal")
    },
    threshold_summary: {
      empirical: summarizeNumbers(runs.map((run) => run.empirical_threshold)),
      risk_controlled: summarizeNumbers(runs.map((run) => run.controlled_threshold))
    }
  };
}

function evaluateDecisions(rows, acceptFn) {
  const accepted = rows.filter(acceptFn);
  const unsafeAccepted = sum(accepted.map((row) => row.unsafe));
  const unsafeTotal = sum(rows.map((row) => row.unsafe));
  const safeTotal = rows.length - unsafeTotal;
  const safeAccepted = accepted.length - unsafeAccepted;
  return {
    cases: rows.length,
    accepted: accepted.length,
    unsafe_accepted: unsafeAccepted,
    automation_yield: accepted.length / rows.length,
    selective_risk: accepted.length ? unsafeAccepted / accepted.length : 0,
    false_accept_rate: unsafeAccepted / rows.length,
    unsafe_detection_sensitivity: unsafeTotal ? (unsafeTotal - unsafeAccepted) / unsafeTotal : 1,
    safe_case_acceptance: safeTotal ? safeAccepted / safeTotal : 0,
    review_rate: 1 - (accepted.length / rows.length),
    selective_risk_wilson_95: wilsonInterval(unsafeAccepted, accepted.length, 1.96)
  };
}

function selectRiskThreshold(rows, targetRisk, options = {}) {
  const candidates = [-Infinity, ...new Set(rows.map((row) => row.risk_score))].sort((a, b) => a - b);
  const correctionCount = Math.max(1, candidates.length - 1);
  let selected = -Infinity;
  for (const threshold of candidates) {
    const accepted = rows.filter((row) => row.risk_score <= threshold);
    if (!accepted.length) continue;
    const errors = sum(accepted.map((row) => row.unsafe));
    const risk = options.confidenceBound
      ? clopperPearsonUpper(errors, accepted.length, (options.delta || 0.05) / correctionCount)
      : errors / accepted.length;
    if (risk <= targetRisk) selected = threshold;
  }
  return selected;
}

function conformalLowRiskSingleton(probability, q) {
  const includesLowRisk = nonconformity(probability, 0) <= q;
  const includesUnsafe = nonconformity(probability, 1) <= q;
  return includesLowRisk && !includesUnsafe;
}

function nonconformity(probabilityUnsafe, label) {
  return label === 1 ? 1 - probabilityUnsafe : probabilityUnsafe;
}

function conformalQuantile(scores, alphaValue) {
  const sorted = [...scores].sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * (1 - alphaValue));
  return rank > sorted.length ? Infinity : sorted[Math.max(0, rank - 1)];
}

function clopperPearsonUpper(errors, total, delta) {
  if (!total || errors >= total) return 1;
  if (errors < 0) return 0;
  let low = errors / total;
  let high = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (low + high) / 2;
    if (binomialCdf(errors, total, mid) > delta) low = mid;
    else high = mid;
  }
  return high;
}

function binomialCdf(k, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let probability = (1 - p) ** n;
  let total = probability;
  for (let value = 1; value <= k; value += 1) {
    probability *= ((n - value + 1) / value) * (p / (1 - p));
    total += probability;
  }
  return Math.min(1, total);
}

function aggregateRuns(runs, key) {
  const metrics = ["automation_yield", "selective_risk", "false_accept_rate", "unsafe_detection_sensitivity", "safe_case_acceptance", "review_rate"];
  return Object.fromEntries(metrics.map((metric) => [metric, summarizeNumbers(runs.map((run) => run[key][metric]))]));
}

function summarizeVerification(rows) {
  return {
    mean_claims: mean(rows.map((row) => row.verification.evidence_claim_count)),
    mean_quote_support_rate: mean(rows.map((row) => row.verification.quote_support_rate)),
    cases_with_unsupported_relationship: rows.filter((row) => row.verification.unsupported_relationship_count > 0).length,
    cases_with_numeric_mismatch: rows.filter((row) => row.verification.numeric_mismatch_count > 0).length,
    cases_with_critical_omission_proxy: rows.filter((row) => row.verification.critical_omission_count > 0).length,
    cases_with_absolute_claim_flag: rows.filter((row) => row.verification.unsupported_absolute_claims.length > 0).length,
    hard_block_cases: rows.filter((row) => row.verification.hard_block).length
  };
}

function signalAssociations(rows) {
  const signals = {
    unsupported_quote: (row) => row.verification.unsupported_quote_count > 0,
    missing_quote: (row) => row.verification.missing_quote_count > 0,
    unsupported_medication_relationship: (row) => row.verification.unsupported_relationship_count > 0,
    numeric_mismatch: (row) => row.verification.numeric_mismatch_count > 0,
    critical_omission_proxy: (row) => row.verification.critical_omission_count > 0,
    unsupported_absolute_claim: (row) => row.verification.unsupported_absolute_claims.length > 0,
    quote_support_below_90pct: (row) => row.verification.quote_support_rate < 0.90,
    atomic_hard_block: (row) => row.verification.hard_block
  };
  return Object.fromEntries(Object.entries(signals).map(([name, predicate]) => {
    const present = rows.filter(predicate);
    const absent = rows.filter((row) => !predicate(row));
    const presentUnsafe = sum(present.map((row) => row.unsafe));
    const absentUnsafe = sum(absent.map((row) => row.unsafe));
    const presentRate = present.length ? presentUnsafe / present.length : null;
    const absentRate = absent.length ? absentUnsafe / absent.length : null;
    const oddsRatio = ((presentUnsafe + 0.5) * ((absent.length - absentUnsafe) + 0.5)) /
      (((present.length - presentUnsafe) + 0.5) * (absentUnsafe + 0.5));
    return [name, {
      present_cases: present.length,
      present_unsafe: presentUnsafe,
      present_unsafe_rate: presentRate,
      absent_cases: absent.length,
      absent_unsafe: absentUnsafe,
      absent_unsafe_rate: absentRate,
      risk_difference: presentRate === null || absentRate === null ? null : presentRate - absentRate,
      odds_ratio_haldane: oddsRatio
    }];
  }));
}

function stratifiedSplit(rows, seed, calibrationFraction) {
  const safe = shuffle(rows.filter((row) => row.unsafe === 0), seed * 2 + 1);
  const unsafe = shuffle(rows.filter((row) => row.unsafe === 1), seed * 2 + 2);
  const split = (items) => Math.max(1, Math.min(items.length - 1, Math.floor(items.length * calibrationFraction)));
  const safeAt = split(safe);
  const unsafeAt = split(unsafe);
  return {
    calibration: shuffle([...safe.slice(0, safeAt), ...unsafe.slice(0, unsafeAt)], seed * 3 + 1),
    test: shuffle([...safe.slice(safeAt), ...unsafe.slice(unsafeAt)], seed * 3 + 2)
  };
}

function wilsonInterval(successes, total, z) {
  if (!total) return [0, 1];
  const p = successes / total;
  const denominator = 1 + (z ** 2 / total);
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / total) + (z ** 2 / (4 * total ** 2))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function renderMarkdown(output) {
  const lines = [
    "# Hybrid Safety-Layer Experiment",
    "",
    `Generated: ${output.generated_at}`,
    "",
    "## Interpretation Boundary",
    "",
    output.caution,
    "",
    `Primary proxy label: ${output.label_definition}`,
    "",
    "The primary operational metric is `selective_risk`: unsafe proxy cases divided by automatically accepted cases. `Automation yield` is reported beside it so a method cannot appear safe merely by escalating almost everything.",
    ""
  ];
  for (const [model, modelReport] of Object.entries(output.models)) {
    lines.push(`## ${model}`, "");
    lines.push(`Cases: ${modelReport.cases}; unsafe proxy cases: ${modelReport.unsafe_proxy_cases} (${pct(modelReport.unsafe_proxy_rate)}); risk-score AUC: ${format(modelReport.risk_score_auc)}.`, "");
    lines.push("### Fixed Rules", "");
    lines.push("| Method | Automation yield | Selective risk | 95% Wilson interval | Unsafe detection | Safe-case acceptance | Review rate |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [method, metrics] of Object.entries(modelReport.fixed_methods)) {
      lines.push(`| ${method} | ${pct(metrics.automation_yield)} | ${pct(metrics.selective_risk)} | ${pct(metrics.selective_risk_wilson_95[0])}-${pct(metrics.selective_risk_wilson_95[1])} | ${pct(metrics.unsafe_detection_sensitivity)} | ${pct(metrics.safe_case_acceptance)} | ${pct(metrics.review_rate)} |`);
    }
    lines.push("", "### Calibrated Routing", "");
    lines.push("Values are means across stratified calibration/test resplits; brackets are the 2.5th-97.5th percentile range.", "");
    lines.push("| Method | Automation yield | Selective risk | Unsafe detection | Safe-case acceptance | Review rate |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [method, metrics] of Object.entries(modelReport.calibrated_methods)) {
      lines.push(`| ${method} | ${range(metrics.automation_yield)} | ${range(metrics.selective_risk)} | ${range(metrics.unsafe_detection_sensitivity)} | ${range(metrics.safe_case_acceptance)} | ${range(metrics.review_rate)} |`);
    }
    const verification = modelReport.verification_summary;
    lines.push("", "### Atomic Verification Signals", "");
    lines.push(`- Mean evidence claims: ${format(verification.mean_claims)}`);
    lines.push(`- Mean literal quote support: ${pct(verification.mean_quote_support_rate)}`);
    lines.push(`- Unsupported medication relationship: ${verification.cases_with_unsupported_relationship}/${modelReport.cases}`);
    lines.push(`- Numeric mismatch: ${verification.cases_with_numeric_mismatch}/${modelReport.cases}`);
    lines.push(`- Critical omission proxy: ${verification.cases_with_critical_omission_proxy}/${modelReport.cases}`);
    lines.push(`- Unsupported absolute-language flag: ${verification.cases_with_absolute_claim_flag}/${modelReport.cases}`);
    lines.push(`- Hard-blocked by the atomic wrapper: ${verification.hard_block_cases}/${modelReport.cases}`, "");
    lines.push("### Signal Association With Unsafe Proxy", "");
    lines.push("| Signal | Present cases | Unsafe when present | Unsafe when absent | Risk difference | Odds ratio |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [signal, values] of Object.entries(modelReport.signal_associations)) {
      lines.push(`| ${signal} | ${values.present_cases} | ${pct(values.present_unsafe_rate)} | ${pct(values.absent_unsafe_rate)} | ${pct(values.risk_difference)} | ${format(values.odds_ratio_haldane)} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Method Notes",
    "",
    "- `accept_all` is the no-safety-layer baseline.",
    "- `quote_only` requires every structured evidence quote to be present literally in the source.",
    "- `atomic_hard_gate` also checks medication-status support, numeric consistency, high-risk omission proxies, and unsupported absolute statements.",
    "- `empirical_score` chooses the highest-yield risk threshold with calibration error at or below alpha; it has no formal finite-sample guarantee.",
    "- `risk_controlled_score` uses a one-sided exact binomial upper bound with Bonferroni correction across tested thresholds. With this small calibration set it may correctly decline to automate anything.",
    "- `split_conformal` accepts only low-risk singleton prediction sets. It controls marginal label-set coverage under exchangeability, not selective clinical risk.",
    "- `hybrid_split_conformal` adds deterministic hard blocks before conformal acceptance.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function parsePairs(value) {
  return value.split(",").map((item) => {
    const [resultsPath, judgmentsPath] = item.split("::");
    if (!resultsPath || !judgmentsPath) throw new Error(`Invalid pair: ${item}`);
    return { resultsPath, judgmentsPath };
  });
}

function arrayAt(object, dottedPath) {
  const value = dottedPath.split(".").reduce((current, key) => current?.[key], object);
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\[\*\*.*?\*\*\]/g, " ").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenCoverage(needle, haystack) {
  const tokens = [...new Set(String(needle).split(" ").filter((token) => token.length >= 3))];
  if (!tokens.length) return haystack.includes(needle) ? 1 : 0;
  const haystackTokens = new Set(String(haystack).split(" "));
  return tokens.filter((token) => haystackTokens.has(token)).length / tokens.length;
}

function extractNumbers(value) {
  return (String(value).match(/\b\d+(?:\.\d+)?\b/g) || []).map((number) => String(Number(number)));
}

function groupBy(items, keyFn) {
  const grouped = {};
  for (const item of items) {
    const key = keyFn(item);
    grouped[key] ||= [];
    grouped[key].push(item);
  }
  return grouped;
}

function shuffle(items, seed) {
  const result = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function auc(items) {
  const positive = items.filter((item) => item.event);
  const negative = items.filter((item) => !item.event);
  if (!positive.length || !negative.length) return null;
  let wins = 0;
  for (const pos of positive) for (const neg of negative) wins += pos.score > neg.score ? 1 : pos.score === neg.score ? 0.5 : 0;
  return wins / (positive.length * negative.length);
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const none = values.filter((value) => value === -Infinity).length;
  return {
    mean: finite.length ? mean(finite) : null,
    p025: finite.length ? quantile(finite, 0.025) : null,
    p975: finite.length ? quantile(finite, 0.975) : null,
    no_accept_threshold_rate: none / values.length
  };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? sum(finite) / finite.length : 0;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function range(summary) {
  if (!summary || summary.mean === null) return "N/A";
  return `${pct(summary.mean)} [${pct(summary.p025)}, ${pct(summary.p975)}]`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
