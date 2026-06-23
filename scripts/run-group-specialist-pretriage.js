#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const routingPaths = (args.routing || "").split(",").map((item) => item.trim()).filter(Boolean);
const outPath = args.out || path.join("results", "group-specialist-pretriage.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const alpha = Number(args.alpha || 0.10);
const repeats = Number(args.repeats || 20);

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

const GROUPS = {
  wound_or_device: (row) => Boolean(row.source_features.wound_or_device_care),
  older_patient_65plus: (row) => Number.isFinite(row.age) && row.age >= 65,
  high_risk_domains_8plus: (row) => riskDomainCount(row) >= 8
};

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
  caution: "Uses model/router outcomes as proxy labels. Group-specialist calibration requires historical labeled/reviewed cases from the same group.",
  models: {}
};

for (const [model, modelRows] of Object.entries(byModel)) {
  output.models[model] = { cases: modelRows.length, groups: {} };
  for (const [groupName, groupFn] of Object.entries(GROUPS)) {
    const groupRows = modelRows.filter(groupFn);
    const backgroundRows = modelRows.filter((row) => !groupFn(row));
    output.models[model].groups[groupName] = {
      cases: groupRows.length,
      targets: {}
    };
    for (const [targetName, targetFn] of Object.entries(TARGETS)) {
      const labeledGroup = groupRows.map((row) => ({ ...row, y: targetFn(row) ? 1 : 0 }));
      const labeledBackground = backgroundRows.map((row) => ({ ...row, y: targetFn(row) ? 1 : 0 }));
      output.models[model].groups[groupName].targets[targetName] = runGroupExperiment(labeledGroup, labeledBackground, repeats, alpha);
    }
  }
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(mdOutPath, renderMarkdown(output));
console.log(`Wrote ${outPath}`);
console.log(`Wrote ${mdOutPath}`);

function buildRow(analysis, testCase) {
  if (!analysis || !testCase) return null;
  const sourceFeatures = analysis.source_features || {};
  const sourceChars = Number(analysis.source_chars || testCase.discharge_summary?.length || 0);
  const age = Number(testCase.age);
  const diagnosis = diagnosisFamily(testCase.admission_diagnosis);
  const featureMap = {
    intercept: 1,
    source_chars: sourceChars,
    log_source_chars: Math.log1p(sourceChars),
    age: Number.isFinite(age) ? age : 0,
    age_missing: Number.isFinite(age) ? 0 : 1,
    source_risk_domain_count: RISK_FEATURES.filter((name) => sourceFeatures[name]).length,
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
    feature_map: featureMap
  };
}

function runGroupExperiment(groupRows, backgroundRows, repeats, alpha) {
  const summaries = [];
  for (let seed = 1; seed <= repeats; seed += 1) {
    const split = splitRows(groupRows, seed);
    if (!split) continue;
    const backgroundSplit = splitRows(backgroundRows, seed + 1000, 0.60, 0.20, 0.20);
    const globalTrain = backgroundSplit ? [...split.train, ...backgroundSplit.train] : split.train;
    const globalCal = backgroundSplit ? [...split.calibration, ...backgroundSplit.calibration] : split.calibration;
    if (!hasBothClasses(split.train) || !hasBothClasses(split.calibration) || !hasBothClasses(globalTrain) || !hasBothClasses(globalCal)) continue;
    summaries.push({
      group_event_rate: mean(groupRows.map((row) => row.y)),
      test_event_rate: mean(split.test.map((row) => row.y)),
      group_train_cases: split.train.length,
      group_calibration_cases: split.calibration.length,
      group_test_cases: split.test.length,
      specialist: fitAndEvaluate(split.train, split.calibration, split.test, alpha),
      global_with_group_history: fitAndEvaluate(globalTrain, globalCal, split.test, alpha),
      guard_all: evaluateGuardAll(split.test)
    });
  }
  return aggregate(summaries);
}

function fitAndEvaluate(trainRows, calibrationRows, testRows, alpha) {
  const featureNames = selectFeatureNames(trainRows);
  const scaler = fitScaler(trainRows, featureNames);
  const model = trainLogistic(
    trainRows.map((row) => vectorize(row, featureNames, scaler)),
    trainRows.map((row) => row.y)
  );
  const calibrationPreds = calibrationRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  const calibrationScores = calibrationRows.map((row, index) => nonconformity(calibrationPreds[index], row.y));
  const q = conformalQuantile(calibrationScores, alpha);
  const testPreds = testRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  return {
    risk_auc: auc(testPreds.map((value, index) => ({ value, event: testRows[index].y === 1 }))),
    ...evaluateConformal(testRows, testPreds, q)
  };
}

function evaluateConformal(testRows, probabilities, q) {
  const records = testRows.map((row, index) => {
    const p = probabilities[index];
    const includesLowRisk = nonconformity(p, 0) <= q;
    const includesEscalation = nonconformity(p, 1) <= q;
    const covered = row.y === 1 ? includesEscalation : includesLowRisk;
    const unsafeLowRisk = includesLowRisk && !includesEscalation && row.y === 1;
    return { includesLowRisk, includesEscalation, covered, unsafeLowRisk };
  });
  return {
    empirical_coverage: mean(records.map((record) => record.covered ? 1 : 0)),
    unsafe_low_risk_rate: mean(records.map((record) => record.unsafeLowRisk ? 1 : 0)),
    escalation_or_uncertain_rate: mean(records.map((record) => record.includesEscalation ? 1 : 0)),
    low_risk_singleton_rate: mean(records.map((record) => record.includesLowRisk && !record.includesEscalation ? 1 : 0))
  };
}

function evaluateGuardAll(testRows) {
  return {
    risk_auc: null,
    empirical_coverage: mean(testRows.map((row) => row.y === 1 ? 1 : 0)),
    unsafe_low_risk_rate: 0,
    escalation_or_uncertain_rate: 1,
    low_risk_singleton_rate: 0
  };
}

function aggregate(values) {
  if (!values.length) return { splits: 0 };
  const methodNames = ["specialist", "global_with_group_history", "guard_all"];
  const out = {
    splits: values.length,
    group_event_rate: mean(values.map((item) => item.group_event_rate)),
    test_event_rate: mean(values.map((item) => item.test_event_rate)),
    group_train_cases: mean(values.map((item) => item.group_train_cases)),
    group_calibration_cases: mean(values.map((item) => item.group_calibration_cases)),
    group_test_cases: mean(values.map((item) => item.group_test_cases))
  };
  for (const method of methodNames) {
    out[method] = {};
    for (const key of Object.keys(values[0][method] || {})) {
      const nums = values.map((item) => item[method]?.[key]).filter(Number.isFinite);
      if (nums.length) out[method][key] = mean(nums);
    }
  }
  return out;
}

function splitRows(rows, seed, trainFraction = 0.60, calibrationFraction = 0.20) {
  if (rows.length < 30) return null;
  const patientGroups = shuffle(Object.values(groupBy(rows, (row) => row.subject_id)), seed);
  const trainEnd = Math.floor(patientGroups.length * trainFraction);
  const calibrationEnd = Math.floor(patientGroups.length * (trainFraction + calibrationFraction));
  const split = {
    train: patientGroups.slice(0, trainEnd).flat(),
    calibration: patientGroups.slice(trainEnd, calibrationEnd).flat(),
    test: patientGroups.slice(calibrationEnd).flat()
  };
  return split.test.length ? split : null;
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

function riskDomainCount(row) {
  return RISK_FEATURES.filter((name) => row.source_features?.[name]).length;
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
    "# Group-Specialist Pre-Triage Experiment",
    "",
    `Generated: ${report.generated_at}`,
    `Target coverage: ${format(report.target_coverage)}`,
    "",
    "## Caution",
    "",
    report.caution,
    "",
    "Methods compared:",
    "",
    "- `specialist`: train and calibrate only within the target group.",
    "- `global_with_group_history`: train and calibrate on broad history that includes target-group examples.",
    "- `guard_all`: force every target-group case to escalation/uncertain.",
    ""
  ];
  for (const [model, modelSummary] of Object.entries(report.models)) {
    lines.push(`## ${model}`, "", `Cases: ${modelSummary.cases}`, "");
    for (const [group, groupSummary] of Object.entries(modelSummary.groups)) {
      lines.push(`### Group: ${group}`, "", `Group cases: ${groupSummary.cases}`, "");
      lines.push("| Target | Splits | Event Rate | Method | Coverage | Unsafe Low-Risk | Esc/Uncertain | Risk AUC |");
      lines.push("| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |");
      for (const [target, targetSummary] of Object.entries(groupSummary.targets)) {
        for (const method of ["specialist", "global_with_group_history", "guard_all"]) {
          const values = targetSummary[method] || {};
          lines.push(`| ${target} | ${targetSummary.splits || 0} | ${format(targetSummary.group_event_rate)} | ${method} | ${format(values.empirical_coverage)} | ${format(values.unsafe_low_risk_rate)} | ${format(values.escalation_or_uncertain_rate)} | ${formatNullable(values.risk_auc)} |`);
        }
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
