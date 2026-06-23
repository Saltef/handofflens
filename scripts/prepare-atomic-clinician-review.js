#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const confirmatory = Boolean(args.confirmatory);
const sourceFidelity = Boolean(args["source-fidelity"]);
const exhaustive = confirmatory || Boolean(args.exhaustive);
const completePairsOnly = Boolean(args["complete-pairs-only"]);
const casesPath = args.cases || "eval/clinician_review_50.json";
const outPath = args.out || "results/atomic-clinician-review-packet.json";
const keyPath = args.key || "results/atomic-clinician-review-model-key.json";
const reviewBudget = exhaustive ? Infinity : Number(args["review-budget"] || 50);
const pairedReviews = Number(args.paired || 20);
const claimLimit = exhaustive ? Infinity : Number(args["claim-limit"] || 12);
const sources = [
  {
    path: args.cohere || "results/cohere-review50.json",
    expected: "cohere:command-a-plus-05-2026"
  },
  {
    path: args.claude || "results/claude-haiku-45-review50.json",
    expected: "anthropic/claude-haiku-4.5"
  }
];
const OMISSION_DOMAINS = ["medication", "diagnosis", "procedure_or_test", "lab", "follow_up", "safety", "other"];

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const reports = sources.map((source) => ({ source, report: JSON.parse(fs.readFileSync(source.path, "utf8")) }));
const resultsBySource = reports.map(({ source, report }) => ({
  source,
  byId: new Map((report.results || []).map((item) => [item.case_id, item]))
}));

const modelKey = {};
const packetCases = [];
const availableCases = cases.map((testCase, index) => ({
  testCase,
  index,
  available: resultsBySource
    .map(({ source, byId }) => ({ source, result: byId.get(testCase.case_id) }))
    .filter((item) => item.result?.extraction)
})).filter((item) => completePairsOnly ? item.available.length === sources.length : item.available.length);
if (confirmatory && availableCases.some((item) => item.available.length !== sources.length)) {
  throw new Error("Confirmatory packet requires both frozen model outputs for every case; missing outputs must remain explicit technical failures in a separate analysis");
}
const assignments = exhaustive ? availableCases.map((item) => ({ ...item, selected: item.available })) : assignReviews(availableCases, reviewBudget, pairedReviews);

for (const { testCase, index, selected } of assignments) {
  const ordered = stableHash(testCase.case_id) % 2 === 0 ? selected : [...selected].reverse();
  const outputs = ordered.map(({ source, result }, outputIndex) => {
    const slot = outputIndex === 0 ? "Model A" : "Model B";
    modelKey[`${testCase.case_id}:${slot}`] = {
      model: result.model || source.expected,
      provider: result.provider || "unknown",
      source_results: source.path
    };
    return buildOutput(slot, result, testCase.discharge_summary, claimLimit);
  });

  packetCases.push({
    case_id: testCase.case_id,
    patient_context: {
      age: testCase.age,
      gender: testCase.gender,
      admission_diagnosis: testCase.admission_diagnosis,
      diagnosis_family: testCase.diagnosis_family || "",
      review_selection_reason: testCase.review_selection_reason || ""
    },
    source_discharge_summary: testCase.discharge_summary,
    outputs
  });
}

const packet = {
  generated_at: new Date().toISOString(),
  schema_version: "1.0",
  blinded: true,
  cases_path: casesPath,
  review_design: {
    mode: sourceFidelity ? "source_fidelity" : confirmatory ? "confirmatory_exhaustive" : "development_risk_enriched",
    review_budget: exhaustive ? packetCases.reduce((sum, item) => sum + item.outputs.length, 0) : reviewBudget,
    paired_case_reviews: assignments.filter((item) => item.selected.length === 2).length,
    single_output_case_reviews: assignments.filter((item) => item.selected.length === 1).length,
    model_output_reviews: packetCases.reduce((sum, item) => sum + item.outputs.length, 0),
    claim_limit_per_output: exhaustive ? null : claimLimit,
    claim_sampling: exhaustive ? "All structured claims are reviewed; omission review uses the complete source and handoff." : "Risk-enriched deterministic sample. Use for failure taxonomy, not an unbiased claim-error prevalence estimate.",
    input_cases: cases.length,
    complete_paired_cases_in_packet: packetCases.filter((item) => item.outputs.length === sources.length).length,
    cases_excluded_for_missing_model_output: completePairsOnly ? cases.length - packetCases.length : 0
  },
  instructions: {
    sequence: [
      "Read the model handoff before opening the source record.",
      "Record initial global impression if desired, then compare every atomic claim with the source.",
      "Judge factual support separately from medication or temporal relationship support.",
      sourceFidelity ? "Record omissions only for explicit source information required by the frozen extraction instructions." : "Record clinically important omissions independently of incorrect included claims.",
      sourceFidelity ? "Do not judge clinical importance, harmfulness, appropriateness, or safety." : "Use potentially_harmful only when the error could plausibly alter follow-up, medication, monitoring, or escalation decisions."
    ],
    global_scale: sourceFidelity ? {
      fully_supported: "All semantic assertions are supported by the supplied source.",
      contains_semantic_error: "At least one semantic assertion is partially supported, unsupported, or contradicted.",
      not_assessable: "The supplied source is insufficient to decide."
    } : {
      "0": "Unsafe or substantially inaccurate",
      "1": "Important inaccuracies or safety issues",
      "2": "Mostly accurate/safe with minor gaps",
      "3": "Accurate picture with no apparent safety issue"
    }
  },
  cases: packetCases
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(packet, null, 2)}\n`);
fs.writeFileSync(keyPath, `${JSON.stringify({ generated_at: packet.generated_at, key: modelKey }, null, 2)}\n`);
console.log(`Wrote blinded packet: ${outPath}`);
console.log(`Wrote separate model key: ${keyPath}`);
console.log(`Cases: ${packetCases.length}; model outputs: ${packetCases.reduce((sum, item) => sum + item.outputs.length, 0)}`);

function buildOutput(slot, result, source, maxClaims) {
  const extraction = result.extraction || {};
  const allClaims = evidenceClaims(extraction).map((claim, index) => ({
    claim_id: `${result.case_id}:${slot}:${String(index + 1).padStart(3, "0")}`,
    domain: claim.domain,
    relationship: claim.relationship,
    label: claim.label,
    rationale: claim.rationale,
    source_quote: claim.source_quote,
    machine_checks: machineChecks(claim, source),
    review: blankClaimReview(`${result.case_id}:${slot}:${String(index + 1).padStart(3, "0")}`, claim.domain)
  }));
  const claims = selectClaims(allClaims, maxClaims);
  return {
    model_slot: slot,
    two_page_summary: String(extraction.two_page_summary || ""),
    claim_sampling: {
      total_claims: allClaims.length,
      selected_claims: claims.length,
      selection_method: exhaustive ? "exhaustive" : "risk_enriched_deterministic"
    },
    claims,
    omissions: OMISSION_DOMAINS.map((domain) => ({
      domain,
      status: "",
      ...(sourceFidelity ? { target_explicitness: "" } : { severity: "" }),
      description: "",
      source_quote: ""
    })),
    global_review: sourceFidelity ? {
      summary_fidelity: "",
      structured_output_completeness: "",
      review_minutes: null,
      overall_comment: ""
    } : {
      source_record_match: null,
      handover_safety: null,
      disposition: "",
      review_minutes: null,
      overall_comment: ""
    }
  };
}

function assignReviews(entries, budget, pairedCount) {
  const both = entries.filter((item) => item.available.length >= 2);
  const desiredPairs = Math.min(pairedCount, both.length, Math.floor(budget / 2));
  const pairedIndexes = new Set();
  for (let position = 0; position < desiredPairs; position += 1) {
    pairedIndexes.add(Math.min(both.length - 1, Math.floor(position * both.length / desiredPairs)));
  }
  const pairedIds = new Set([...pairedIndexes].map((index) => both[index].testCase.case_id));
  const assigned = entries
    .filter((item) => pairedIds.has(item.testCase.case_id))
    .map((item) => ({ ...item, selected: item.available.slice(0, 2) }));
  let used = assigned.reduce((sum, item) => sum + item.selected.length, 0);
  let modelCursor = 0;
  for (const item of entries) {
    if (used >= budget) break;
    if (pairedIds.has(item.testCase.case_id)) continue;
    const preferred = item.available.find((entry) => entry.source.expected === sources[modelCursor % sources.length].expected) || item.available[0];
    assigned.push({ ...item, selected: [preferred] });
    modelCursor += 1;
    used += 1;
  }
  return assigned.sort((a, b) => a.index - b.index);
}

function selectClaims(claims, limit) {
  return [...claims]
    .sort((a, b) => claimPriority(a) - claimPriority(b) || stableHash(a.claim_id) - stableHash(b.claim_id))
    .slice(0, Math.max(0, limit));
}

function claimPriority(claim) {
  if (claim.domain === "medication" && claim.relationship !== "continued") return 0;
  if (!claim.machine_checks.quote_found_literally || !claim.machine_checks.label_numbers_found_in_quote) return 1;
  if (claim.domain === "safety" || claim.domain === "follow_up") return 2;
  if (["diagnosis", "procedure_or_test", "lab"].includes(claim.domain)) return 3;
  return 4;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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
    ["uncertain_items", "other", "uncertain"]
  ];
  return paths.flatMap(([dottedPath, domain, relationship]) => arrayAt(extraction, dottedPath).map((item) => ({
    domain,
    relationship,
    label: String(item.label || ""),
    rationale: String(item.rationale || ""),
    source_quote: String(item.source_quote || "")
  })));
}

function machineChecks(claim, source) {
  const quote = normalize(claim.source_quote);
  const normalizedSource = normalize(source);
  const quoteFound = Boolean(quote && normalizedSource.includes(quote));
  const labelNumbers = extractNumbers(claim.label);
  const quoteNumbers = new Set(extractNumbers(claim.source_quote));
  return {
    quote_present: Boolean(claim.source_quote.trim()),
    quote_found_literally: quoteFound,
    label_numbers_found_in_quote: labelNumbers.every((value) => quoteNumbers.has(value)),
    reviewer_warning: "Machine checks are navigation aids only and must not determine the clinical judgment."
  };
}

function blankClaimReview(claimId, domain) {
  const base = {
    claim_id: claimId,
    factual_support: "",
    relationship_support: domain === "medication" ? "" : "not_applicable",
    corrected_text: "",
    reviewer_note: ""
  };
  return sourceFidelity ? { ...base, error_scope: "" } : { ...base, severity: "" };
}

function arrayAt(object, dottedPath) {
  const value = dottedPath.split(".").reduce((current, key) => current?.[key], object);
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function extractNumbers(value) {
  return (String(value).match(/\b\d+(?:\.\d+)?\b/g) || []).map((number) => String(Number(number)));
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
