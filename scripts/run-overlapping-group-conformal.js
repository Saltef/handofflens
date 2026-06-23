#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const routingPaths = (args.routing || "").split(",").map((item) => item.trim()).filter(Boolean);
const outPath = args.out || path.join("results", "overlapping-group-conformal.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const alpha = Number(args.alpha || 0.10);
const repeats = Number(args.repeats || 20);
const minGroupCalibration = Number(args["min-group-calibration"] || 20);

if (!routingPaths.length) throw new Error("--routing is required");

const RISK_FEATURES = [
  "medication_list_present",
  "anticoagulation_or_bleeding",
  "antibiotics_or_infection",
  "renal_or_dosing",
  "respiratory_or_oxygen",
  "wound_or_device_care",
  "pending_or_follow_up",
  "icu_or_goals",
  "long_note",
  "sparse_note"
];

const DIAGNOSIS_FAMILIES = [
  "cardiovascular",
  "respiratory",
  "infection",
  "gastrointestinal",
  "renal",
  "neurologic",
  "surgical_or_wound",
  "oncology",
  "other"
];

const TARGETS = {
  technical_failure: (row) => row.issues.some((issue) => issue.type === "technical_failure") || row.allocation === "retry_or_alternate_model",
  clinician_or_human_review: (row) => ["clinician_review", "human_review", "medication_reconciliation_review"].includes(row.allocation)
};

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const reports = routingPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
const rows = reports
  .flatMap((report) => report.analyses || [])
  .map((analysis) => buildRow(analysis, casesById.get(analysis.case_id)))
  .filter(Boolean);
const byModel = groupBy(rows, (row) => row.model);

const output = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  routing_paths: routingPaths,
  alpha,
  target_coverage: 1 - alpha,
  min_group_calibration: minGroupCalibration,
  caution: "Uses model/router outcomes as proxy labels. Overlapping group-conformal thresholds are evaluated for routing risk, not clinical truth.",
  models: {}
};

for (const [model, modelRows] of Object.entries(byModel)) {
  output.models[model] = { cases: modelRows.length, targets: {} };
  for (const [targetName, targetFn] of Object.entries(TARGETS)) {
    const labeled = modelRows.map((row) => ({ ...row, y: targetFn(row) ? 1 : 0 }));
    output.models[model].targets[targetName] = runExperiment(labeled, alpha, repeats, minGroupCalibration);
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(mdOutPath, renderMarkdown(output));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdOutPath}`);

function buildRow(analysis, testCase) {
  if (!analysis || !testCase) return null;
  const source = String(testCase.discharge_summary || "");
  const sourceFeatures = analysis.source_features || {};
  const density = noteDensity(source);
  const sourceChars = Number(analysis.source_chars || source.length || 0);
  const age = Number(testCase.age);
  const diagnosis = diagnosisFamily(testCase.admission_diagnosis);
  const riskDomainCount = RISK_FEATURES.filter((name) => sourceFeatures[name]).length;
  const groupMap = buildGroupMap({ sourceFeatures, density, sourceChars, age, diagnosis, riskDomainCount });
  const featureMap = {
    intercept: 1,
    source_chars: sourceChars,
    log_source_chars: Math.log1p(sourceChars),
    estimated_tokens: density.estimated_tokens,
    context_pct_128k: density.context_pct_128k,
    med_line_count: density.med_line_count,
    lab_value_count: density.lab_value_count,
    procedure_term_count: density.procedure_term_count,
    followup_term_count: density.followup_term_count,
    section_header_count: density.section_header_count,
    deid_marker_count: density.deid_marker_count,
    list_line_count: density.list_line_count,
    source_risk_domain_count: riskDomainCount,
    age: Number.isFinite(age) ? age : 0,
    age_missing: Number.isFinite(age) ? 0 : 1,
    gender_female: String(testCase.gender || "").toUpperCase() === "F" ? 1 : 0,
    gender_male: String(testCase.gender || "").toUpperCase() === "M" ? 1 : 0
  };
  for (const name of RISK_FEATURES) featureMap[name] = sourceFeatures[name] ? 1 : 0;
  for (const family of DIAGNOSIS_FAMILIES) featureMap[`diagnosis_${family}`] = diagnosis === family ? 1 : 0;
  return {
    case_id: analysis.case_id,
    subject_id: String(testCase.subject_id || analysis.case_id),
    model: analysis.model,
    allocation: analysis.allocation,
    issues: analysis.issues || [],
    source_features: sourceFeatures,
    source_chars: sourceChars,
    age: Number.isFinite(age) ? age : null,
    diagnosis_family: diagnosis,
    density,
    groups: groupMap,
    feature_map: featureMap
  };
}

function noteDensity(source) {
  const lines = source.split(/\r?\n/);
  return {
    estimated_tokens: Math.ceil(source.length / 4),
    context_pct_128k: Math.ceil(source.length / 4) / 128000,
    med_line_count: lines.filter((line) => /^\s*(\d+\.|-)?\s*[A-Z]?[a-z]+[a-z-]*\s+\d+(\.\d+)?\s*(mg|mcg|g|units?|ml|tablet|capsule|puff|inh|po|iv|sc|subq)\b/i.test(line)).length,
    lab_value_count: (source.match(/\b(?:Na|K|Cl|HCO3|BUN|Creat|Cr|WBC|Hct|Hgb|Plt|INR|PTT|Glucose|Calcium|Mg|Phos)[-\s:]*\d+(\.\d+)?/gi) || []).length,
    procedure_term_count: (source.match(/\b(?:procedure|surgery|operation|catheter|line|tube|drain|intubat|extubat|biopsy|ct|mri|x-ray|echo|ultrasound|cabg|valve|bronchoscopy|endoscopy|colonoscopy)\b/gi) || []).length,
    followup_term_count: (source.match(/\b(?:follow.?up|appointment|clinic|pcp|pending|repeat|monitor|return|call)\b/gi) || []).length,
    section_header_count: lines.filter((line) => /^[A-Z][A-Z /\-()]{3,}:?\s*$/.test(line.trim())).length,
    deid_marker_count: (source.match(/\[\*\*/g) || []).length,
    list_line_count: lines.filter((line) => /^\s*(\d+\.|-)\s+/.test(line)).length
  };
}

function buildGroupMap({ sourceFeatures, density, sourceChars, age, diagnosis, riskDomainCount }) {
  return {
    age_65plus: Number.isFinite(age) && age >= 65,
    age_80plus: Number.isFinite(age) && age >= 80,
    newborn: Number.isFinite(age) && age === 0,
    long_note: sourceChars > 15000,
    very_long_note: density.estimated_tokens > 5000,
    high_context_pressure: density.context_pct_128k > 0.04,
    high_med_density: density.med_line_count >= 12,
    high_lab_density: density.lab_value_count >= 20,
    high_procedure_density: density.procedure_term_count >= 20,
    high_followup_density: density.followup_term_count >= 8,
    high_deid_density: density.deid_marker_count >= 80,
    high_list_density: density.list_line_count >= 25,
    risk_domains_6plus: riskDomainCount >= 6,
    risk_domains_8plus: riskDomainCount >= 8,
    medication_list_present: Boolean(sourceFeatures.medication_list_present),
    anticoagulation_or_bleeding: Boolean(sourceFeatures.anticoagulation_or_bleeding),
    antibiotics_or_infection: Boolean(sourceFeatures.antibiotics_or_infection),
    renal_or_dosing: Boolean(sourceFeatures.renal_or_dosing),
    respiratory_or_oxygen: Boolean(sourceFeatures.respiratory_or_oxygen),
    wound_or_device_care: Boolean(sourceFeatures.wound_or_device_care),
    pending_or_follow_up: Boolean(sourceFeatures.pending_or_follow_up),
    icu_or_goals: Boolean(sourceFeatures.icu_or_goals),
    [`diagnosis_${diagnosis}`]: true
  };
}

function runExperiment(rows, alpha, repeats, minGroupCalibration) {
  const summaries = [];
  for (let seed = 1; seed <= repeats; seed += 1) {
    const split = randomSplit(rows, seed);
    if (!hasBothClasses(split.train) || !hasBothClasses(split.calibration)) continue;
    summaries.push(evaluateSplit(split.train, split.calibration, split.test, alpha, minGroupCalibration));
  }
  return aggregateRuns(summaries);
}

function evaluateSplit(trainRows, calibrationRows, testRows, alpha, minGroupCalibration) {
  const featureNames = selectFeatureNames(trainRows);
  const scaler = fitScaler(trainRows, featureNames);
  const model = trainLogistic(
    trainRows.map((row) => vectorize(row, featureNames, scaler)),
    trainRows.map((row) => row.y)
  );
  const calibrationPreds = calibrationRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  const calibrationScores = calibrationRows.map((row, index) => nonconformity(calibrationPreds[index], row.y));
  const globalQ = conformalQuantile(calibrationScores, alpha);
  const groupThresholds = groupConformalThresholds(calibrationRows, calibrationScores, alpha, minGroupCalibration);
  const testPreds = testRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  const methods = {
    global: evaluateConformal(testRows, testPreds, (row) => globalQ),
    overlapping_group: evaluateConformal(testRows, testPreds, (row) => groupAwareThreshold(row, globalQ, groupThresholds)),
    guarded_group: evaluateConformal(testRows, testPreds, (row) => groupAwareThreshold(row, globalQ, groupThresholds), { forceEscalation: isExtremeRisk })
  };
  return {
    test_event_rate: mean(testRows.map((row) => row.y)),
    risk_auc: auc(testPreds.map((score, index) => ({ value: score, event: testRows[index].y === 1 }))),
    methods,
    groups: evaluateGroups(testRows, testPreds, globalQ, groupThresholds)
  };
}

function evaluateGroups(testRows, testPreds, globalQ, groupThresholds) {
  const groupNames = [...new Set(testRows.flatMap((row) => Object.entries(row.groups).filter(([, value]) => value).map(([name]) => name)))].sort();
  const out = {};
  for (const groupName of groupNames) {
    const indexes = testRows.map((row, index) => ({ row, index })).filter(({ row }) => row.groups[groupName]);
    if (indexes.length < 10) continue;
    const rows = indexes.map(({ row }) => row);
    const preds = indexes.map(({ index }) => testPreds[index]);
    out[groupName] = {
      cases: rows.length,
      event_rate: mean(rows.map((row) => row.y)),
      global: evaluateConformal(rows, preds, () => globalQ),
      overlapping_group: evaluateConformal(rows, preds, (row) => groupAwareThreshold(row, globalQ, groupThresholds)),
      guarded_group: evaluateConformal(rows, preds, (row) => groupAwareThreshold(row, globalQ, groupThresholds), { forceEscalation: isExtremeRisk })
    };
  }
  return out;
}

function groupConformalThresholds(calibrationRows, calibrationScores, alpha, minGroupCalibration) {
  const groupedScores = {};
  for (let index = 0; index < calibrationRows.length; index += 1) {
    for (const [groupName, present] of Object.entries(calibrationRows[index].groups || {})) {
      if (!present) continue;
      groupedScores[groupName] ||= [];
      groupedScores[groupName].push(calibrationScores[index]);
    }
  }
  const thresholds = {};
  for (const [groupName, scores] of Object.entries(groupedScores)) {
    if (scores.length < minGroupCalibration) continue;
    thresholds[groupName] = {
      q: conformalQuantile(scores, alpha),
      n: scores.length
    };
  }
  return thresholds;
}

function groupAwareThreshold(row, globalQ, groupThresholds) {
  const thresholds = Object.entries(row.groups || {})
    .filter(([, present]) => present)
    .map(([groupName]) => groupThresholds[groupName]?.q)
    .filter(Number.isFinite);
  return thresholds.length ? Math.max(globalQ, ...thresholds) : globalQ;
}

function evaluateConformal(testRows, probabilities, qFn, options = {}) {
  const records = testRows.map((row, index) => {
    const q = qFn(row);
    const p = probabilities[index];
    const forceEscalation = Boolean(options.forceEscalation?.(row));
    const includesLowRisk = nonconformity(p, 0) <= q;
    const includesEscalation = forceEscalation || nonconformity(p, 1) <= q;
    return {
      covered: row.y === 1 ? includesEscalation : includesLowRisk,
      unsafeLowRisk: includesLowRisk && !includesEscalation && row.y === 1,
      includesEscalation,
      lowRiskSingleton: includesLowRisk && !includesEscalation
    };
  });
  return {
    empirical_coverage: mean(records.map((record) => record.covered ? 1 : 0)),
    unsafe_low_risk_rate: mean(records.map((record) => record.unsafeLowRisk ? 1 : 0)),
    escalation_or_uncertain_rate: mean(records.map((record) => record.includesEscalation ? 1 : 0)),
    low_risk_singleton_rate: mean(records.map((record) => record.lowRiskSingleton ? 1 : 0))
  };
}

function isExtremeRisk(row) {
  return Boolean(
    row.groups.risk_domains_8plus ||
    (row.groups.wound_or_device_care && row.groups.high_med_density) ||
    (row.groups.renal_or_dosing && row.groups.anticoagulation_or_bleeding) ||
    (row.groups.icu_or_goals && row.groups.respiratory_or_oxygen)
  );
}

function aggregateRuns(runs) {
  const methods = ["global", "overlapping_group", "guarded_group"];
  const out = {
    splits: runs.length,
    test_event_rate: mean(runs.map((run) => run.test_event_rate)),
    risk_auc: mean(runs.map((run) => run.risk_auc).filter(Number.isFinite)),
    methods: {},
    groups: {}
  };
  for (const method of methods) out.methods[method] = aggregateMetricObjects(runs.map((run) => run.methods[method]));
  const groupNames = [...new Set(runs.flatMap((run) => Object.keys(run.groups)))].sort();
  for (const groupName of groupNames) {
    const values = runs.map((run) => run.groups[groupName]).filter(Boolean);
    if (values.length < Math.ceil(runs.length / 2)) continue;
    out.groups[groupName] = {
      splits: values.length,
      cases: mean(values.map((item) => item.cases)),
      event_rate: mean(values.map((item) => item.event_rate)),
      global: aggregateMetricObjects(values.map((item) => item.global)),
      overlapping_group: aggregateMetricObjects(values.map((item) => item.overlapping_group)),
      guarded_group: aggregateMetricObjects(values.map((item) => item.guarded_group))
    };
  }
  out.worst_groups = {};
  for (const method of methods) {
    const rows = Object.entries(out.groups)
      .map(([groupName, value]) => ({ group: groupName, ...value[method], event_rate: value.event_rate, cases: value.cases }))
      .filter((item) => Number.isFinite(item.unsafe_low_risk_rate))
      .sort((a, b) => b.unsafe_low_risk_rate - a.unsafe_low_risk_rate)
      .slice(0, 12);
    out.worst_groups[method] = rows;
  }
  return out;
}

function aggregateMetricObjects(values) {
  const keys = [...new Set(values.flatMap((item) => Object.keys(item || {})))];
  return Object.fromEntries(keys.map((key) => [key, mean(values.map((item) => item?.[key]).filter(Number.isFinite))]));
}

function randomSplit(rows, seed) {
  const patientGroups = shuffle(Object.values(groupBy(rows, (row) => row.subject_id)), seed);
  const trainEnd = Math.floor(patientGroups.length * 0.60);
  const calibrationEnd = Math.floor(patientGroups.length * 0.80);
  return {
    train: patientGroups.slice(0, trainEnd).flat(),
    calibration: patientGroups.slice(trainEnd, calibrationEnd).flat(),
    test: patientGroups.slice(calibrationEnd).flat()
  };
}

function trainLogistic(xRows, yValues) {
  const weights = Array(xRows[0].length).fill(0);
  const lr = 0.08;
  const l2 = 0.001;
  for (let epoch = 0; epoch < 800; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (let i = 0; i < xRows.length; i += 1) {
      const error = sigmoid(dot(weights, xRows[i])) - yValues[i];
      for (let j = 0; j < weights.length; j += 1) gradient[j] += error * xRows[i][j];
    }
    for (let j = 0; j < weights.length; j += 1) {
      weights[j] -= lr * ((gradient[j] / xRows.length) + (j === 0 ? 0 : l2 * weights[j]));
    }
  }
  return { weights };
}

function predictProbability(model, x) {
  return sigmoid(dot(model.weights, x));
}

function nonconformity(probabilityEscalation, label) {
  return label === 1 ? 1 - probabilityEscalation : probabilityEscalation;
}

function conformalQuantile(scores, alpha) {
  const sorted = [...scores].sort((a, b) => a - b);
  const rank = Math.ceil((scores.length + 1) * (1 - alpha));
  if (rank > sorted.length) return Infinity;
  return sorted[Math.max(0, rank - 1)];
}

function selectFeatureNames(rows) {
  return [...new Set(rows.flatMap((row) => Object.keys(row.feature_map)))].sort();
}

function fitScaler(rows, featureNames) {
  const scaler = {};
  for (const name of featureNames) {
    const values = rows.map((row) => Number(row.feature_map[name] || 0));
    const avg = mean(values);
    const variance = mean(values.map((value) => (value - avg) ** 2));
    scaler[name] = { mean: avg, sd: Math.sqrt(variance) || 1 };
  }
  scaler.intercept = { mean: 0, sd: 1 };
  return scaler;
}

function vectorize(row, featureNames, scaler) {
  return featureNames.map((name) => {
    if (name === "intercept") return 1;
    return (Number(row.feature_map[name] || 0) - scaler[name].mean) / scaler[name].sd;
  });
}

function hasBothClasses(rows) {
  const labels = new Set(rows.map((row) => row.y));
  return labels.has(0) && labels.has(1);
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
    "# Overlapping Group-Conformal Experiment",
    "",
    `Generated: ${report.generated_at}`,
    `Target coverage: ${format(report.target_coverage)}`,
    `Minimum group calibration size: ${report.min_group_calibration}`,
    "",
    "## Caution",
    "",
    report.caution,
    "",
    "Methods:",
    "",
    "- `global`: one pooled conformal threshold.",
    "- `overlapping_group`: pooled risk model, but threshold is the most conservative available threshold among all groups the case belongs to.",
    "- `guarded_group`: overlapping-group threshold plus deterministic escalation for extreme risk combinations.",
    ""
  ];
  for (const [model, modelSummary] of Object.entries(report.models)) {
    lines.push(`## ${model}`, "", `Cases: ${modelSummary.cases}`, "");
    for (const [target, targetSummary] of Object.entries(modelSummary.targets)) {
      lines.push(`### Target: ${target}`, "");
      lines.push(`Splits: ${targetSummary.splits}`);
      lines.push(`Test event rate: ${format(targetSummary.test_event_rate)}`);
      lines.push(`Risk AUC: ${formatNullable(targetSummary.risk_auc)}`, "");
      lines.push("| Method | Coverage | Unsafe Low-Risk | Esc/Uncertain | Low-Risk Singleton |");
      lines.push("| --- | ---: | ---: | ---: | ---: |");
      for (const [method, values] of Object.entries(targetSummary.methods)) {
        lines.push(`| ${method} | ${format(values.empirical_coverage)} | ${format(values.unsafe_low_risk_rate)} | ${format(values.escalation_or_uncertain_rate)} | ${format(values.low_risk_singleton_rate)} |`);
      }
      lines.push("", "#### Worst Groups By Unsafe Low-Risk", "");
      for (const method of ["global", "overlapping_group", "guarded_group"]) {
        lines.push(`##### ${method}`, "");
        lines.push("| Group | Cases | Event Rate | Unsafe Low-Risk | Esc/Uncertain | Coverage |");
        lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
        for (const row of targetSummary.worst_groups[method] || []) {
          lines.push(`| ${row.group} | ${format(row.cases)} | ${format(row.event_rate)} | ${format(row.unsafe_low_risk_rate)} | ${format(row.escalation_or_uncertain_rate)} | ${format(row.empirical_coverage)} |`);
        }
        lines.push("");
      }
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

function shuffle(items, seed) {
  const shuffled = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
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

function dot(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

function sigmoid(value) {
  if (value < -35) return 0;
  if (value > 35) return 1;
  return 1 / (1 + Math.exp(-value));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function format(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "N/A";
}

function formatNullable(value) {
  return value === null || value === undefined ? "N/A" : format(value);
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
