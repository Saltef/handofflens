#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const args = parseArgs(process.argv.slice(2));
const casesPath = required(args.cases, "--cases is required");
const routingPaths = (args.routing || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const outPath = args.out || path.join("results", "conformal-pretriage.json");
const mdOutPath = args.mdout || outPath.replace(/\.json$/i, ".md");
const alpha = Number(args.alpha || 0.10);
const repeats = Number(args.repeats || 10);
const neighborhoodK = Number(args.k || 75);

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

if (!routingPaths.length) throw new Error("--routing is required");
if (!(alpha > 0 && alpha < 1)) throw new Error("--alpha must be between 0 and 1");

const cases = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const casesById = new Map(cases.map((item) => [item.case_id, item]));
const reports = routingPaths.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
const analyses = reports.flatMap((report) => report.analyses || []);
const rows = analyses.map((item) => buildRow(item, casesById.get(item.case_id))).filter(Boolean);
const byModel = groupBy(rows, (item) => item.model);

const targets = {
  technical_failure: (row) => row.issues.some((issue) => issue.type === "technical_failure") || row.allocation === "retry_or_alternate_model",
  strict_escalation: (row) => !["accept_as_draft", "clinician_spot_check"].includes(row.allocation),
  clinician_or_human_review: (row) => ["clinician_review", "human_review", "medication_reconciliation_review"].includes(row.allocation)
};

const output = {
  generated_at: new Date().toISOString(),
  cases_path: casesPath,
  routing_paths: routingPaths,
  alpha,
  target_coverage: 1 - alpha,
  neighborhood_k: neighborhoodK,
  caution: "This is a proxy-label experiment using model/router outcomes, not clinician-adjudicated truth. It tests whether pre-generation features can calibrate routing risk.",
  models: {}
};

for (const [model, modelRows] of Object.entries(byModel)) {
  output.models[model] = {
    cases: modelRows.length,
    targets: {}
  };
  for (const [targetName, targetFn] of Object.entries(targets)) {
    const labeled = modelRows.map((row) => ({ ...row, y: targetFn(row) ? 1 : 0 }));
    output.models[model].targets[targetName] = runTargetExperiments(labeled, targetName, alpha, repeats, neighborhoodK);
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
  const riskDomainCount = RISK_FEATURES.filter((name) => sourceFeatures[name]).length;
  const diagnosis = diagnosisFamily(testCase.admission_diagnosis);
  const featureMap = {
    intercept: 1,
    source_chars: sourceChars,
    log_source_chars: Math.log1p(sourceChars),
    age: Number.isFinite(age) ? age : 0,
    age_missing: Number.isFinite(age) ? 0 : 1,
    source_risk_domain_count: riskDomainCount,
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
    source_chars: sourceChars,
    age: Number.isFinite(age) ? age : null,
    diagnosis_family: diagnosis,
    source_features: sourceFeatures,
    feature_map: featureMap
  };
}

function runTargetExperiments(rows, targetName, alpha, repeats, neighborhoodK) {
  const eventRate = mean(rows.map((row) => row.y));
  const scenarios = makeScenarios(rows, repeats);
  const scenarioSummaries = {};
  for (const scenario of scenarios) {
    const train = scenario.train.map((index) => rows[index]);
    const calibration = scenario.calibration.map((index) => rows[index]);
    const test = scenario.test.map((index) => rows[index]);
    if (!hasBothClasses(train) || !hasBothClasses(calibration) || !test.length) continue;
    const result = evaluateSplit(train, calibration, test, alpha, neighborhoodK);
    scenarioSummaries[scenario.name] ||= [];
    scenarioSummaries[scenario.name].push({ ...result, split: scenario.detail });
  }
  return {
    event_rate: eventRate,
    event_count: rows.filter((row) => row.y === 1).length,
    scenarios: Object.fromEntries(Object.entries(scenarioSummaries).map(([name, values]) => [name, aggregateScenario(values, 1 - alpha)]))
  };
}

function evaluateSplit(trainRows, calibrationRows, testRows, alpha, neighborhoodK) {
  const featureNames = selectFeatureNames(trainRows);
  const scaler = fitScaler(trainRows, featureNames);
  const trainX = trainRows.map((row) => vectorize(row, featureNames, scaler));
  const trainY = trainRows.map((row) => row.y);
  const model = trainLogistic(trainX, trainY);

  const calibrationPreds = calibrationRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  const calibrationScores = calibrationRows.map((row, index) => nonconformity(calibrationPreds[index], row.y));
  const globalQ = conformalQuantile(calibrationScores, alpha);
  const calibrationVectors = calibrationRows.map((row) => vectorize(row, featureNames, scaler));

  const testPreds = testRows.map((row) => predictProbability(model, vectorize(row, featureNames, scaler)));
  const testVectors = testRows.map((row) => vectorize(row, featureNames, scaler));

  return {
    train_cases: trainRows.length,
    calibration_cases: calibrationRows.length,
    test_cases: testRows.length,
    test_event_rate: mean(testRows.map((row) => row.y)),
    risk_model_auc: auc(testPreds.map((score, index) => ({ value: score, event: testRows[index].y === 1 }))),
    global_conformal: evaluateConformal(testRows, testPreds, () => globalQ),
    guarded_global_conformal: evaluateConformal(testRows, testPreds, () => globalQ, { forceEscalation: isGuardedShift }),
    neighborhood_conformal: evaluateConformal(testRows, testPreds, (index) => {
      const nearest = nearestCalibrationScores(testVectors[index], calibrationVectors, calibrationScores, neighborhoodK);
      return conformalQuantile(nearest, alpha);
    }),
    guarded_neighborhood_conformal: evaluateConformal(testRows, testPreds, (index) => {
      const nearest = nearestCalibrationScores(testVectors[index], calibrationVectors, calibrationScores, neighborhoodK);
      return conformalQuantile(nearest, alpha);
    }, { forceEscalation: isGuardedShift }),
    fixed_threshold_050: evaluateFixedThreshold(testRows, testPreds, 0.50),
    fixed_threshold_025: evaluateFixedThreshold(testRows, testPreds, 0.25)
  };
}

function evaluateConformal(testRows, probabilities, qFn, options = {}) {
  const records = testRows.map((row, index) => {
    const p = probabilities[index];
    const q = qFn(index);
    const guarded = Boolean(options.forceEscalation?.(row));
    const includesLowRisk = nonconformity(p, 0) <= q;
    const includesEscalation = guarded || nonconformity(p, 1) <= q;
    const setSize = Number(includesLowRisk) + Number(includesEscalation);
    const covered = row.y === 1 ? includesEscalation : includesLowRisk;
    const unsafeLowRisk = includesLowRisk && !includesEscalation && row.y === 1;
    return { row, p, q, guarded, includesLowRisk, includesEscalation, setSize, covered, unsafeLowRisk };
  });
  return {
    empirical_coverage: mean(records.map((record) => record.covered ? 1 : 0)),
    unsafe_low_risk_rate: mean(records.map((record) => record.unsafeLowRisk ? 1 : 0)),
    unsafe_low_risk_count: records.filter((record) => record.unsafeLowRisk).length,
    guard_trigger_rate: mean(records.map((record) => record.guarded ? 1 : 0)),
    low_risk_singleton_rate: mean(records.map((record) => record.includesLowRisk && !record.includesEscalation ? 1 : 0)),
    escalation_or_uncertain_rate: mean(records.map((record) => record.includesEscalation ? 1 : 0)),
    ambiguous_set_rate: mean(records.map((record) => record.includesLowRisk && record.includesEscalation ? 1 : 0)),
    empty_set_rate: mean(records.map((record) => record.setSize === 0 ? 1 : 0)),
    average_set_size: mean(records.map((record) => record.setSize))
  };
}

function isGuardedShift(row) {
  const riskDomainCount = RISK_FEATURES.filter((name) => row.source_features?.[name]).length;
  return Boolean(
    row.source_features?.wound_or_device_care ||
    (Number.isFinite(row.age) && row.age >= 65) ||
    riskDomainCount >= 8
  );
}

function evaluateFixedThreshold(testRows, probabilities, threshold) {
  const records = testRows.map((row, index) => {
    const predictedEscalation = probabilities[index] >= threshold;
    return {
      predictedEscalation,
      unsafeLowRisk: !predictedEscalation && row.y === 1,
      correct: predictedEscalation === Boolean(row.y)
    };
  });
  return {
    threshold,
    accuracy: mean(records.map((record) => record.correct ? 1 : 0)),
    unsafe_low_risk_rate: mean(records.map((record) => record.unsafeLowRisk ? 1 : 0)),
    escalation_rate: mean(records.map((record) => record.predictedEscalation ? 1 : 0))
  };
}

function nearestCalibrationScores(testVector, calibrationVectors, calibrationScores, k) {
  return calibrationVectors
    .map((vector, index) => ({ score: calibrationScores[index], distance: euclidean(testVector, vector) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.min(k, calibrationScores.length))
    .map((item) => item.score);
}

function makeScenarios(rows, repeats) {
  const scenarios = [];
  for (let seed = 1; seed <= repeats; seed += 1) {
    const split = randomSplit(rows, seed);
    scenarios.push({ name: "random_iid", detail: `seed_${seed}`, ...split });
  }
  const values = rows.map((row) => row.source_chars).sort((a, b) => a - b);
  const p75 = percentile(values, 0.75);
  const p90 = percentile(values, 0.90);
  const scenarioDefs = [
    ["long_note_shift", (row) => row.source_chars >= p75],
    ["very_long_note_shift", (row) => row.source_chars >= p90],
    ["infection_or_antibiotic_shift", (row) => Boolean(row.source_features.antibiotics_or_infection)],
    ["respiratory_or_oxygen_shift", (row) => Boolean(row.source_features.respiratory_or_oxygen)],
    ["wound_or_device_shift", (row) => Boolean(row.source_features.wound_or_device_care)],
    ["older_patient_shift", (row) => Number.isFinite(row.age) && row.age >= 65],
    ["high_risk_domain_shift", (row) => RISK_FEATURES.filter((name) => row.source_features[name]).length >= 8],
    ["cardiovascular_shift", (row) => row.diagnosis_family === "cardiovascular"],
    ["gastrointestinal_shift", (row) => row.diagnosis_family === "gastrointestinal"],
    ["newborn_shift", (row) => Number.isFinite(row.age) && row.age === 0]
  ];
  for (const [name, isTarget] of scenarioDefs) {
    for (let seed = 1; seed <= repeats; seed += 1) {
      const split = shiftedSplit(rows, isTarget, seed);
      if (split) scenarios.push({ name, detail: `seed_${seed}`, ...split });
    }
  }
  return scenarios;
}

function randomSplit(rows, seed) {
  const groups = patientIndexGroups(rows);
  const patients = shuffle(Object.values(groups), seed);
  const trainEnd = Math.floor(patients.length * 0.60);
  const calibrationEnd = Math.floor(patients.length * 0.80);
  return {
    train: patients.slice(0, trainEnd).flat(),
    calibration: patients.slice(trainEnd, calibrationEnd).flat(),
    test: patients.slice(calibrationEnd).flat()
  };
}

function shiftedSplit(rows, isTarget, seed) {
  const target = [];
  const source = [];
  for (const indexes of Object.values(patientIndexGroups(rows))) {
    (indexes.some((index) => isTarget(rows[index])) ? target : source).push(indexes);
  }
  if (target.length < 20 || source.length < 40) return null;
  const shuffledSource = shuffle(source, seed);
  const trainEnd = Math.max(20, Math.floor(shuffledSource.length * 0.70));
  return {
    train: shuffledSource.slice(0, trainEnd).flat(),
    calibration: shuffledSource.slice(trainEnd).flat(),
    test: shuffle(target, seed + 1000).flat()
  };
}

function patientIndexGroups(rows) {
  const groups = {};
  rows.forEach((row, index) => {
    const key = String(row.subject_id || row.case_id);
    groups[key] ||= [];
    groups[key].push(index);
  });
  return groups;
}

function trainLogistic(xRows, yValues) {
  const weights = Array(xRows[0].length).fill(0);
  const lr = 0.08;
  const l2 = 0.001;
  for (let epoch = 0; epoch < 800; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    for (let i = 0; i < xRows.length; i += 1) {
      const prediction = sigmoid(dot(weights, xRows[i]));
      const error = prediction - yValues[i];
      for (let j = 0; j < weights.length; j += 1) gradient[j] += error * xRows[i][j];
    }
    for (let j = 0; j < weights.length; j += 1) {
      const penalty = j === 0 ? 0 : l2 * weights[j];
      weights[j] -= lr * ((gradient[j] / xRows.length) + penalty);
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
  if (!scores.length) return Infinity;
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
    const value = Number(row.feature_map[name] || 0);
    return (value - scaler[name].mean) / scaler[name].sd;
  });
}

function aggregateScenario(values, targetCoverage) {
  const methods = [
    "global_conformal",
    "guarded_global_conformal",
    "neighborhood_conformal",
    "guarded_neighborhood_conformal",
    "fixed_threshold_050",
    "fixed_threshold_025"
  ];
  const out = {
    splits: values.length,
    train_cases_mean: mean(values.map((item) => item.train_cases)),
    calibration_cases_mean: mean(values.map((item) => item.calibration_cases)),
    test_cases_mean: mean(values.map((item) => item.test_cases)),
    test_event_rate_mean: mean(values.map((item) => item.test_event_rate)),
    risk_model_auc_mean: mean(values.map((item) => item.risk_model_auc).filter(Number.isFinite))
  };
  for (const method of methods) {
    const keys = Object.keys(values[0][method] || {});
    out[method] = {};
    for (const key of keys) {
      const nums = values.map((item) => item[method]?.[key]).filter(Number.isFinite);
      if (nums.length) {
        out[method][key] = mean(nums);
        if (key === "empirical_coverage") {
          out[method].empirical_coverage_min = Math.min(...nums);
          out[method].empirical_coverage_p10 = percentile([...nums].sort((a, b) => a - b), 0.10);
          out[method].coverage_under_target_rate = mean(nums.map((value) => value < targetCoverage ? 1 : 0));
        }
        if (key === "unsafe_low_risk_rate") out[method].unsafe_low_risk_rate_max = Math.max(...nums);
      }
    }
  }
  return out;
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
    "# Conformal Pre-Triage Experiment",
    "",
    `Generated: ${report.generated_at}`,
    `Target coverage: ${format(report.target_coverage)}`,
    `Neighborhood k: ${report.neighborhood_k}`,
    "",
    "## Caution",
    "",
    report.caution,
    "",
    "The core safety metric is `unsafe_low_risk_rate`: cases predicted as low-risk singleton by the conformal set even though the observed workflow label required escalation/failure.",
    ""
  ];
  for (const [model, modelSummary] of Object.entries(report.models)) {
    lines.push(`## ${model}`, "", `Cases: ${modelSummary.cases}`, "");
    for (const [target, targetSummary] of Object.entries(modelSummary.targets)) {
      lines.push(`### Target: ${target}`, "");
      lines.push(`Event count: ${targetSummary.event_count}`);
      lines.push(`Event rate: ${format(targetSummary.event_rate)}`, "");
      lines.push("| Scenario | Splits | Test Event Rate | Risk AUC | Global Cov | Global Unsafe | Global Esc/Unc | Guarded Cov | Guarded Unsafe | Guarded Esc/Unc | Neighborhood Cov | Neighborhood Unsafe | Guarded Nbr Unsafe |");
      lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
      for (const [scenario, values] of Object.entries(targetSummary.scenarios)) {
        lines.push([
          scenario,
          values.splits,
          format(values.test_event_rate_mean),
          formatNullable(values.risk_model_auc_mean),
          format(values.global_conformal.empirical_coverage),
          format(values.global_conformal.unsafe_low_risk_rate),
          format(values.global_conformal.escalation_or_uncertain_rate),
          format(values.guarded_global_conformal.empirical_coverage),
          format(values.guarded_global_conformal.unsafe_low_risk_rate),
          format(values.guarded_global_conformal.escalation_or_uncertain_rate),
          format(values.neighborhood_conformal.empirical_coverage),
          format(values.neighborhood_conformal.unsafe_low_risk_rate),
          format(values.guarded_neighborhood_conformal.unsafe_low_risk_rate)
        ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
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

function euclidean(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += (a[index] - b[index]) ** 2;
  return Math.sqrt(sum);
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

function percentile(values, p) {
  if (!values.length) return 0;
  return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];
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
