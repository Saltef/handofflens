#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const routingPaths = (args.routing || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const outPath = args.out || path.join("results", "feature-predictiveness.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");

if (!routingPaths.length) throw new Error("--routing is required");

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const reports = routingPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
const analyses = reports.flatMap((report) => report.analyses || []);
const byModel = groupBy(analyses, (item) => item.model || "unknown");

const output = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  routing_paths: routingPaths,
  caution: "Exploratory association analysis using pre-generation case features and workflow outcomes. This does not establish clinical truth or causality.",
  models: {}
};

for (const [model, items] of Object.entries(byModel)) {
  const enriched = enrichItems(items, casesById);
  const targets = {
    technical_failure: (item) => item.issues.some((issue) => issue.type === "technical_failure") || item.allocation === "retry_or_alternate_model",
    retry_or_alternate_model: (item) => item.allocation === "retry_or_alternate_model",
    clinician_review: (item) => item.allocation === "clinician_review",
    human_or_medication_review: (item) => ["human_review", "medication_reconciliation_review"].includes(item.allocation),
    any_escalation_except_spot_check: (item) => !["accept_as_draft", "clinician_spot_check"].includes(item.allocation)
  };
  output.models[model] = {
    cases: enriched.length,
    target_event_rates: Object.fromEntries(Object.entries(targets).map(([name, fn]) => [name, rate(enriched, fn)])),
    source_feature_prevalence: summarizeFeaturePrevalence(enriched),
    targets: Object.fromEntries(Object.entries(targets).map(([name, fn]) => [name, analyzeTarget(enriched, fn)])),
    numeric_predictors: analyzeNumericPredictors(enriched, targets)
  };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(mdOutPath, renderMarkdown(output));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdOutPath}`);

function enrichItems(items, casesById) {
  const lengths = items.map((item) => item.source_chars).filter(Number.isFinite).sort((a, b) => a - b);
  const p10 = percentile(lengths, 0.10);
  const p25 = percentile(lengths, 0.25);
  const p50 = percentile(lengths, 0.50);
  const p75 = percentile(lengths, 0.75);
  const p90 = percentile(lengths, 0.90);

  return items.map((item) => {
    const testCase = casesById.get(item.case_id) || {};
    const age = Number(testCase.age);
    const sourceFeatures = item.source_features || {};
    const highRiskCount = [
      "medication_list_present",
      "anticoagulation_or_bleeding",
      "antibiotics_or_infection",
      "renal_or_dosing",
      "respiratory_or_oxygen",
      "wound_or_device_care",
      "pending_or_follow_up",
      "icu_or_goals"
    ].filter((key) => sourceFeatures[key]).length;
    const sourceChars = Number(item.source_chars || 0);
    return {
      ...item,
      case: testCase,
      age,
      source_chars: sourceChars,
      feature_map: {
        ...sourceFeatures,
        length_shortest_decile: sourceChars <= p10,
        length_shortest_quartile: sourceChars <= p25,
        length_longest_quartile: sourceChars >= p75,
        length_longest_decile: sourceChars >= p90,
        length_above_median: sourceChars >= p50,
        high_risk_domains_6plus: highRiskCount >= 6,
        high_risk_domains_8plus: highRiskCount >= 8,
        age_newborn: Number.isFinite(age) && age === 0,
        age_65plus: Number.isFinite(age) && age >= 65,
        age_80plus: Number.isFinite(age) && age >= 80,
        gender_female: String(testCase.gender || "").toUpperCase() === "F",
        gender_male: String(testCase.gender || "").toUpperCase() === "M",
        [`diagnosis_${diagnosisFamily(testCase.admission_diagnosis)}`]: true
      }
    };
  });
}

function summarizeFeaturePrevalence(items) {
  const names = featureNames(items);
  return Object.fromEntries(names.map((name) => [name, items.filter((item) => item.feature_map[name]).length]));
}

function analyzeTarget(items, targetFn) {
  const eventCount = items.filter(targetFn).length;
  const baseRate = items.length ? eventCount / items.length : 0;
  const rows = featureNames(items).map((feature) => associationForFeature(items, feature, targetFn, baseRate));
  return {
    events: eventCount,
    event_rate: baseRate,
    top_by_abs_phi: rows
      .filter((row) => row.present_count >= 10 && row.absent_count >= 10)
      .sort((a, b) => Math.abs(b.phi) - Math.abs(a.phi))
      .slice(0, 20),
    top_by_risk_difference: rows
      .filter((row) => row.present_count >= 10 && row.absent_count >= 10)
      .sort((a, b) => Math.abs(b.risk_difference) - Math.abs(a.risk_difference))
      .slice(0, 20)
  };
}

function associationForFeature(items, feature, targetFn) {
  let a = 0; // feature present, event
  let b = 0; // feature present, no event
  let c = 0; // feature absent, event
  let d = 0; // feature absent, no event
  for (const item of items) {
    const present = Boolean(item.feature_map[feature]);
    const event = Boolean(targetFn(item));
    if (present && event) a += 1;
    else if (present && !event) b += 1;
    else if (!present && event) c += 1;
    else d += 1;
  }
  const presentRate = ratio(a, a + b);
  const absentRate = ratio(c, c + d);
  const oddsRatio = ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5));
  const denominator = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  const phi = denominator ? ((a * d) - (b * c)) / denominator : 0;
  return {
    feature,
    present_count: a + b,
    absent_count: c + d,
    event_when_present: a,
    event_when_absent: c,
    event_rate_when_present: presentRate,
    event_rate_when_absent: absentRate,
    risk_difference: presentRate - absentRate,
    risk_ratio: absentRate ? presentRate / absentRate : null,
    odds_ratio: oddsRatio,
    phi
  };
}

function analyzeNumericPredictors(items, targets) {
  const numeric = {
    source_chars: (item) => item.source_chars,
    age: (item) => item.age,
    source_risk_domain_count: (item) => [
      "medication_list_present",
      "anticoagulation_or_bleeding",
      "antibiotics_or_infection",
      "renal_or_dosing",
      "respiratory_or_oxygen",
      "wound_or_device_care",
      "pending_or_follow_up",
      "icu_or_goals"
    ].filter((key) => item.source_features?.[key]).length
  };
  const out = {};
  for (const [targetName, targetFn] of Object.entries(targets)) {
    out[targetName] = Object.fromEntries(Object.entries(numeric).map(([name, valueFn]) => {
      const pairs = items
        .map((item) => ({ value: valueFn(item), event: targetFn(item) }))
        .filter((item) => Number.isFinite(item.value));
      return [name, {
        auc_higher_predicts_event: auc(pairs),
        mean_when_event: mean(pairs.filter((item) => item.event).map((item) => item.value)),
        mean_when_no_event: mean(pairs.filter((item) => !item.event).map((item) => item.value))
      }];
    }));
  }
  return out;
}

function auc(pairs) {
  const positives = pairs.filter((item) => item.event);
  const negatives = pairs.filter((item) => !item.event);
  if (!positives.length || !negatives.length) return null;
  let wins = 0;
  let ties = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      if (pos.value > neg.value) wins += 1;
      else if (pos.value === neg.value) ties += 1;
    }
  }
  return (wins + 0.5 * ties) / (positives.length * negatives.length);
}

function featureNames(items) {
  return [...new Set(items.flatMap((item) => Object.keys(item.feature_map || {})))].sort();
}

function diagnosisFamily(value) {
  const text = String(value || "unknown").toLowerCase();
  if (/(cabg|coronary|cardiac|heart|valve|myocard|aortic|mitral|atrial|chf|cad)/.test(text)) return "cardiovascular";
  if (/(copd|pneumonia|respiratory|asthma|hypoxia|emphysema|lung)/.test(text)) return "respiratory";
  if (/(sepsis|infection|bacteremia|fever|cellulitis)/.test(text)) return "infection";
  if (/(gi|gastro|bleed|abdominal|bowel|liver|pancrea|chole)/.test(text)) return "gastrointestinal";
  if (/(renal|kidney|dialysis|esrd|urinary)/.test(text)) return "renal";
  if (/(stroke|seizure|hemorrhage|neuro|brain|spine|mental)/.test(text)) return "neurologic";
  if (/(fracture|joint|hip|knee|orthopedic|wound|ulcer|gangrene|amputation)/.test(text)) return "surgical_or_wound";
  if (/(cancer|mass|tumor|lymphoma|leukemia|carcinoma)/.test(text)) return "oncology";
  return "other";
}

function renderMarkdown(report) {
  const lines = [
    "# Feature Predictiveness Analysis",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Caution",
    "",
    report.caution,
    "",
    "Targets are workflow outcomes derived from model/router results. They are useful for pre-triage design, but they are not clinician-adjudicated truth.",
    ""
  ];

  for (const [model, summary] of Object.entries(report.models)) {
    lines.push(`## ${model}`, "");
    lines.push(`Cases: ${summary.cases}`, "");
    lines.push("### Target Event Rates", "", "| Target | Events | Rate |", "| --- | ---: | ---: |");
    for (const [target, value] of Object.entries(summary.target_event_rates)) {
      lines.push(`| ${target} | ${Math.round(value * summary.cases)} | ${format(value)} |`);
    }
    lines.push("", "### Numeric Predictors", "");
    lines.push("| Target | Predictor | AUC Higher Predicts Event | Mean if Event | Mean if No Event |");
    lines.push("| --- | --- | ---: | ---: | ---: |");
    for (const [target, predictors] of Object.entries(summary.numeric_predictors)) {
      for (const [name, values] of Object.entries(predictors)) {
        lines.push(`| ${target} | ${name} | ${formatNullable(values.auc_higher_predicts_event)} | ${formatNumber(values.mean_when_event)} | ${formatNumber(values.mean_when_no_event)} |`);
      }
    }
    lines.push("");
    for (const target of ["technical_failure", "clinician_review", "human_or_medication_review"]) {
      const targetSummary = summary.targets[target];
      if (!targetSummary) continue;
      lines.push(`### Top Source Features For ${target}`, "");
      lines.push("| Feature | Present | Event Rate Present | Event Rate Absent | Risk Diff | Risk Ratio | Phi |");
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const row of targetSummary.top_by_abs_phi.slice(0, 12)) {
        lines.push(`| ${row.feature} | ${row.present_count} | ${format(row.event_rate_when_present)} | ${format(row.event_rate_when_absent)} | ${format(row.risk_difference)} | ${formatNullable(row.risk_ratio)} | ${format(row.phi)} |`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
  }
  return groups;
}

function rate(items, fn) {
  return items.length ? items.filter(fn).length / items.length : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function formatNullable(value) {
  return value === null || value === undefined ? "N/A" : format(value);
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : "N/A";
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
