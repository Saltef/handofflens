#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const outPath = args.out || path.join("results", "routing-analysis.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const resultPaths = (args.results || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!resultPaths.length) throw new Error("--results is required");

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const reports = resultPaths.map((filePath) => ({ filePath, report: JSON.parse(fs.readFileSync(filePath, "utf8")) }));
const analyses = reports.flatMap(({ filePath, report }) => (report.results || []).map((result) => analyzeResult(filePath, result, casesById.get(result.case_id))));

const output = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  result_paths: resultPaths,
  summary: summarize(analyses),
  analyses
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(mdOutPath, renderMarkdown(output));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdOutPath}`);

function analyzeResult(sourceReport, result, testCase = {}) {
  const source = String(testCase.discharge_summary || "");
  const extraction = result.extraction || {};
  const sourceFeatures = detectSourceFeatures(source);
  const extractionFeatures = detectExtractionFeatures(extraction);
  const evidence = inspectEvidence(extraction, source);
  const summary = String(extraction.two_page_summary || "");
  const issues = [];

  if (result.error) issues.push(issue("technical_failure", "retry", result.error));
  if (!result.error && !summary.trim()) issues.push(issue("empty_summary", "retry", "two_page_summary is empty"));
  if (!result.error && summary.trim().length > 0 && summary.trim().length < 500 && source.length > 5000) {
    issues.push(issue("short_summary_for_long_note", "stronger_model_or_retry", "Summary is short relative to source note length"));
  }
  if (Array.isArray(result.schema_repairs) && result.schema_repairs.length > 0) {
    issues.push(issue("schema_repair", "human_review", result.schema_repairs.join("; ")));
  }
  if (evidence.missing_source_quote_count > 0) {
    issues.push(issue("missing_source_quote", "human_review", `${evidence.missing_source_quote_count} evidence items lack source_quote`));
  }
  if (evidence.unsupported_quote_count > 0) {
    issues.push(issue("quote_not_found_in_source", "human_review", `${evidence.unsupported_quote_count} source_quote strings were not found in source text`));
  }

  if (sourceFeatures.medication_list_present && extractionFeatures.medication_item_count === 0) {
    issues.push(issue("medication_list_without_extracted_medications", "medication_reconciliation_review", "Source has medication list language but no medication changes were extracted"));
  }
  if (sourceFeatures.anticoagulation_or_bleeding && !extractionFeatures.has_anticoag_or_bleeding) {
    issues.push(issue("anticoagulation_or_bleeding_not_flagged", "clinician_review", "Source suggests anticoagulation or bleeding risk but extraction did not flag it"));
  }
  if (sourceFeatures.antibiotics_or_infection && !extractionFeatures.has_antibiotic_or_infection) {
    issues.push(issue("infection_or_antibiotic_not_flagged", "clinician_review", "Source suggests infection/antibiotics/cultures but extraction did not flag it"));
  }
  if (sourceFeatures.renal_or_dosing && !extractionFeatures.has_renal) {
    issues.push(issue("renal_or_dosing_not_flagged", "clinician_review", "Source suggests renal disease/dosing risk but extraction did not flag it"));
  }
  if (sourceFeatures.respiratory_or_oxygen && !extractionFeatures.has_respiratory) {
    issues.push(issue("respiratory_or_oxygen_not_flagged", "clinician_review", "Source suggests oxygen/respiratory failure but extraction did not flag it"));
  }
  if (sourceFeatures.wound_or_device_care && !extractionFeatures.has_wound_or_device) {
    issues.push(issue("wound_or_device_not_flagged", "clinician_review", "Source suggests wound/device/catheter/tube care but extraction did not flag it"));
  }
  if (sourceFeatures.pending_or_follow_up && extractionFeatures.follow_up_count === 0) {
    issues.push(issue("follow_up_language_without_follow_up_actions", "clinician_review", "Source suggests pending/follow-up needs but no follow-up actions were extracted"));
  }
  if (sourceFeatures.long_note && extractionFeatures.total_item_count > 80) {
    issues.push(issue("high_volume_extraction", "human_review", "Very large extraction may be difficult to verify and should be sampled/reviewed"));
  }
  if (sourceFeatures.sparse_note && extractionFeatures.total_item_count > 25) {
    issues.push(issue("dense_extraction_from_sparse_note", "human_review", "Sparse source note generated many extracted items; possible over-inference"));
  }

  const allocation = allocate(issues, sourceFeatures);
  return {
    source_report: sourceReport,
    provider: result.provider,
    model: result.model,
    case_id: result.case_id,
    latency_ms: result.latency_ms,
    allocation,
    issues,
    source_features: sourceFeatures,
    extraction_features: extractionFeatures,
    evidence_quality: evidence,
    summary_chars: summary.length,
    source_chars: source.length
  };
}

function issue(type, route, detail) {
  return { type, route, detail };
}

function allocate(issues, sourceFeatures) {
  const types = new Set(issues.map((item) => item.type));
  if (types.has("technical_failure") || types.has("empty_summary")) return "retry_or_alternate_model";
  if (types.has("medication_list_without_extracted_medications")) return "medication_reconciliation_review";
  if (issues.some((item) => item.route === "clinician_review")) return "clinician_review";
  if (issues.some((item) => item.route === "stronger_model_or_retry")) return "stronger_model_or_retry";
  if (issues.some((item) => item.route === "human_review")) return "human_review";
  if (sourceFeatures.anticoagulation_or_bleeding || sourceFeatures.renal_or_dosing || sourceFeatures.respiratory_or_oxygen) return "clinician_spot_check";
  return "accept_as_draft";
}

function detectSourceFeatures(source) {
  const text = source.toLowerCase();
  return {
    long_note: source.length > 15000,
    sparse_note: source.length < 2500,
    medication_list_present: /discharge medications|medications on admission|home medications|medications:/i.test(source),
    anticoagulation_or_bleeding: /coumadin|warfarin|heparin|lovenox|enoxaparin|anticoag|bleed|hemorrhage|inr|ptt/i.test(source),
    antibiotics_or_infection: /vancomycin|zosyn|cef|cipro|levofloxacin|azithro|flagyl|antibiotic|culture|bacter|sepsis|pneumonia|abscess/i.test(source),
    renal_or_dosing: /creatinine|renal|kidney|dialysis|bun|ckd|arf|aki|nephro/i.test(source),
    respiratory_or_oxygen: /oxygen|intubat|ventilat|hypox|respiratory failure|peep|trach|nasal cannula/i.test(source),
    wound_or_device_care: /wound|drain|foley|catheter|picc|central line|tube|staple|suture|device|ostomy/i.test(source),
    pending_or_follow_up: /follow.?up|appointment|clinic|pcp|return|monitor|pending|repeat/i.test(source),
    icu_or_goals: /icu|expired|death|comfort|withdraw|dnr|family meeting|pressor/i.test(source)
  };
}

function detectExtractionFeatures(extraction) {
  const medicationItems = [
    ...arrayAt(extraction, "medication_changes.started"),
    ...arrayAt(extraction, "medication_changes.stopped"),
    ...arrayAt(extraction, "medication_changes.changed"),
    ...arrayAt(extraction, "medication_changes.continued"),
    ...arrayAt(extraction, "medication_changes.uncertain")
  ];
  const followUp = arrayAt(extraction, "follow_up_actions");
  const safety = arrayAt(extraction, "safety_flags");
  const labs = arrayAt(extraction, "labs");
  const procedures = arrayAt(extraction, "procedures_and_tests");
  const diagnoses = [
    ...arrayAt(extraction, "diagnosis_changes.discharge"),
    ...arrayAt(extraction, "diagnosis_changes.new_or_changed")
  ];
  const allText = JSON.stringify({ medicationItems, followUp, safety, labs, procedures, diagnoses }).toLowerCase();
  const totalItemCount = medicationItems.length + followUp.length + safety.length + labs.length + procedures.length + diagnoses.length + arrayAt(extraction, "uncertain_items").length;
  return {
    medication_item_count: medicationItems.length,
    follow_up_count: followUp.length,
    safety_count: safety.length,
    lab_count: labs.length,
    procedure_test_count: procedures.length,
    diagnosis_count: diagnoses.length,
    total_item_count: totalItemCount,
    uncertain_count: arrayAt(extraction, "uncertain_items").length,
    has_anticoag_or_bleeding: /coumadin|warfarin|heparin|lovenox|enoxaparin|anticoag|bleed|hemorrhage|inr|ptt/.test(allText),
    has_antibiotic_or_infection: /vancomycin|zosyn|cef|cipro|levofloxacin|azithro|flagyl|antibiotic|culture|bacter|sepsis|pneumonia|abscess/.test(allText),
    has_renal: /creatinine|renal|kidney|dialysis|bun|ckd|arf|aki|nephro/.test(allText),
    has_respiratory: /oxygen|intubat|ventilat|hypox|respiratory failure|peep|trach|nasal cannula/.test(allText),
    has_wound_or_device: /wound|drain|foley|catheter|picc|central line|tube|staple|suture|device|ostomy/.test(allText)
  };
}

function inspectEvidence(extraction, source) {
  const items = evidenceItems(extraction);
  const normalizedSource = normalize(source);
  const missing = items.filter((item) => !String(item.source_quote || "").trim());
  const unsupported = items.filter((item) => {
    const quote = String(item.source_quote || "").trim();
    if (!quote) return false;
    return !normalizedSource.includes(normalize(quote));
  });
  return {
    evidence_item_count: items.length,
    missing_source_quote_count: missing.length,
    unsupported_quote_count: unsupported.length,
    unsupported_quote_rate: items.length ? unsupported.length / items.length : 0
  };
}

function evidenceItems(extraction) {
  return [
    ...arrayAt(extraction, "medication_changes.started"),
    ...arrayAt(extraction, "medication_changes.stopped"),
    ...arrayAt(extraction, "medication_changes.changed"),
    ...arrayAt(extraction, "medication_changes.continued"),
    ...arrayAt(extraction, "medication_changes.uncertain"),
    ...arrayAt(extraction, "diagnosis_changes.discharge"),
    ...arrayAt(extraction, "diagnosis_changes.new_or_changed"),
    ...arrayAt(extraction, "procedures_and_tests"),
    ...arrayAt(extraction, "labs"),
    ...arrayAt(extraction, "follow_up_actions"),
    ...arrayAt(extraction, "safety_flags"),
    ...arrayAt(extraction, "uncertain_items")
  ];
}

function arrayAt(object, dottedPath) {
  const value = dottedPath.split(".").reduce((current, key) => current?.[key], object);
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function summarize(analyses) {
  const byModel = {};
  for (const item of analyses) {
    byModel[item.model] ||= [];
    byModel[item.model].push(item);
  }
  return Object.fromEntries(Object.entries(byModel).map(([model, items]) => {
    const allocationCounts = countBy(items.map((item) => item.allocation));
    const issueCounts = countBy(items.flatMap((item) => item.issues.map((issue) => issue.type)));
    const featureCounts = {};
    for (const item of items) {
      for (const [feature, present] of Object.entries(item.source_features)) {
        if (present) featureCounts[feature] = (featureCounts[feature] || 0) + 1;
      }
    }
    return [model, {
      cases: items.length,
      allocation_counts: allocationCounts,
      issue_counts: issueCounts,
      source_feature_counts: Object.fromEntries(Object.entries(featureCounts).sort((a, b) => b[1] - a[1])),
      mean_latency_ms: mean(items.map((item) => item.latency_ms)),
      mean_unsupported_quote_rate: mean(items.map((item) => item.evidence_quality.unsupported_quote_rate))
    }];
  }));
}

function countBy(items) {
  const counts = {};
  for (const item of items.filter(Boolean)) counts[item] = (counts[item] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function renderMarkdown(report) {
  const lines = [
    "# Deterministic Routing Analysis",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Model Summary",
    "",
    "| Model | Cases | Accept Draft | Clinician Spot Check | Clinician Review | Medication Review | Human Review | Retry/Alternate | Stronger Model/Retry | Mean Latency ms | Mean Unsupported Quote Rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const [model, summary] of Object.entries(report.summary)) {
    const counts = summary.allocation_counts;
    lines.push(`| \`${model}\` | ${summary.cases} | ${counts.accept_as_draft || 0} | ${counts.clinician_spot_check || 0} | ${counts.clinician_review || 0} | ${counts.medication_reconciliation_review || 0} | ${counts.human_review || 0} | ${counts.retry_or_alternate_model || 0} | ${counts.stronger_model_or_retry || 0} | ${Math.round(summary.mean_latency_ms)} | ${format(summary.mean_unsupported_quote_rate)} |`);
  }
  lines.push("", "## Top Issue Types", "");
  for (const [model, summary] of Object.entries(report.summary)) {
    lines.push(`### ${model}`, "");
    const issues = Object.entries(summary.issue_counts);
    lines.push(issues.length ? issues.map(([name, count]) => `- ${name}: ${count}`).join("\n") : "- none");
    lines.push("");
  }
  lines.push(
    "## Allocation Policy",
    "",
    "- `retry_or_alternate_model`: technical failure, empty summary, malformed output.",
    "- `medication_reconciliation_review`: source has medication-list language but extraction has no medication changes.",
    "- `clinician_review`: deterministic source risk signal appears missing from extracted safety/follow-up/medication fields.",
    "- `stronger_model_or_retry`: likely under-complete output, such as short summary for long note.",
    "- `human_review`: evidence/quote/schema repair issues where source support is not reliably contestable.",
    "- `clinician_spot_check`: no direct extraction issue fired, but the source contains high-risk domains that merit sampling or review.",
    "- `accept_as_draft`: no deterministic trigger fired; still not clinical sign-off.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
