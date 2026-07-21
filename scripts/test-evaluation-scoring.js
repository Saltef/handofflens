#!/usr/bin/env node

const assert = require("node:assert/strict");
const { analyzeAtomViewCoverage, canonicalizeExtractionViews, scoreExtraction, scoreList, scoreSafetyList, tokenF1 } = require("./evaluate-models");

const strictDose = scoreList(
  ["Furosemide dose increased from 20 mg daily to 40 mg daily"],
  ["furosemide increased to 40 mg daily"],
  { mode: "strict" }
);
const relaxedDose = scoreList(
  ["Furosemide dose increased from 20 mg daily to 40 mg daily"],
  ["furosemide increased to 40 mg daily"],
  { mode: "relaxed" }
);

assert.equal(strictDose.true_positive, 0);
assert.equal(relaxedDose.true_positive, 1);
assert.equal(tokenF1("wound monitoring signs infection", "fever"), 0);

const extraction = {
  medication_changes: {
    started: [],
    stopped: [],
    changed: [{ label: "Metformin increased from 500 mg twice daily to 1000 mg twice daily" }],
    continued: [],
    uncertain: [],
  },
  diagnosis_changes: { new_or_changed: [] },
  procedures_and_tests: [],
  labs: [],
  follow_up_actions: [
    { label: "Wound clinic appointment in 4 days for dressing change" },
    { label: "Primary care appointment in 2 weeks for diabetes review" },
  ],
  safety_flags: [{ label: "Wound monitoring for signs of infection" }],
};

const score = scoreExtraction(extraction, {
  "medication_changes.changed": ["metformin increased to 1000 mg twice daily"],
  follow_up_actions: ["wound clinic in 4 days", "primary care in 2 weeks"],
  safety_flags: ["fever", "spreading redness"],
});

assert.equal(score.categories["medication_changes.changed"].true_positive, 0);
assert.equal(score.relaxed_categories["medication_changes.changed"].true_positive, 1);
assert.equal(score.categories.follow_up_actions.true_positive, 0);
assert.equal(score.relaxed_categories.follow_up_actions.true_positive, 2);
assert.equal(score.relaxed_categories.safety_flags.true_positive, 0);
assert.ok(score.relaxed_overall.f1 > score.overall.f1);

const safetyScore = scoreSafetyList(
  [
    { label: "Call if weight gain > 2 kg in 3 days", safety_type: "return_precaution" },
    { label: "monitor potassium and creatinine", safety_type: "return_precaution" },
    { label: "Wound monitoring for signs of infection", safety_type: "return_precaution" },
  ],
  [
    { label: "call for weight gain above 2 kg in 3 days", safety_type: "return_precaution" },
    { label: "monitor potassium and creatinine", safety_type: "monitoring_instruction" },
  ],
  { mode: "relaxed" }
);

assert.equal(safetyScore.true_positive, 1);
assert.equal(safetyScore.false_positive, 2);
assert.equal(safetyScore.false_negative, 1);
assert.equal(safetyScore.type_analysis.by_type.return_precaution.true_positive, 1);
assert.equal(safetyScore.type_analysis.missing_by_type.monitoring_instruction, 1);
assert.equal(safetyScore.type_analysis.false_positive_by_type.return_precaution, 2);
assert.equal(safetyScore.type_analysis.wrong_type, 1);

const monitoringScore = scoreSafetyList(
  [{ label: "Primary care lab check potassium and creatinine in 3 days", safety_type: "monitoring_instruction" }],
  [{ label: "monitor potassium and creatinine", safety_type: "monitoring_instruction" }],
  { mode: "relaxed" }
);

assert.equal(monitoringScore.true_positive, 1);
assert.equal(monitoringScore.false_positive, 0);
assert.equal(monitoringScore.false_negative, 0);

const typedScore = scoreExtraction(
  { safety_flags: [{ label: "Return promptly for fever", safety_type: "monitoring_instruction" }] },
  { safety_flags: [{ label: "fever", safety_type: "return_precaution" }] }
);

assert.equal(typedScore.categories.safety_flags.true_positive, 0);
assert.equal(typedScore.relaxed_categories.safety_flags.true_positive, 0);
assert.equal(typedScore.safety_type_analysis.wrong_type, 1);

const atomCoverageInput = {
  handoff_atoms: [
    {
      atom_id: "A1",
      label: "Primary care laboratory check for potassium and creatinine in 3 days",
      instruction_kind: "lab_monitoring",
      safety_type: "monitoring_instruction",
      action: "laboratory check",
      target: "potassium and creatinine",
      time_window: "in 3 days",
      threshold: "",
      owner: "primary care",
      derived_views: ["follow_up_actions", "safety_flags"],
      source_quote: "Primary care laboratory check for potassium and creatinine in 3 days."
    },
    {
      atom_id: "A2",
      label: "call for weight gain above 2 kg in 3 days",
      instruction_kind: "return_precaution",
      safety_type: "return_precaution",
      action: "call",
      target: "weight gain",
      time_window: "in 3 days",
      threshold: "above 2 kg",
      owner: "patient",
      derived_views: ["safety_flags"],
      source_quote: "Record daily weight and call for a gain above 2 kg in 3 days."
    }
  ],
  follow_up_actions: [
    { label: "Primary care laboratory check for potassium and creatinine in 3 days" }
  ],
  safety_flags: [
    { label: "Call if daily weight gain exceeds 2 kg", safety_type: "return_precaution" }
  ]
};

const atomCoverage = analyzeAtomViewCoverage(atomCoverageInput);

assert.equal(atomCoverage.atom_count, 2);
assert.equal(atomCoverage.atom_view_expectations, 3);
assert.equal(atomCoverage.by_view.follow_up_actions.matched, 1);
assert.equal(atomCoverage.by_view.safety_flags.matched, 0);
assert.equal(atomCoverage.by_view.safety_flags.expected, 2);
assert.equal(atomCoverage.missing_view_items.length, 2);
assert.equal(atomCoverage.view_items_without_atom.length, 1);

const canonicalized = canonicalizeExtractionViews(atomCoverageInput);
const canonicalCoverage = analyzeAtomViewCoverage(canonicalized.extraction);

assert.equal(canonicalized.audit.projected_from_atoms.length, 2);
assert.equal(canonicalized.audit.backfilled_atoms.length, 1);
assert.equal(canonicalized.audit.operation_count, 3);
assert.ok(canonicalized.extraction.safety_flags.some((item) => (
  item.label.includes("potassium and creatinine") && item.safety_type === "monitoring_instruction"
)));
assert.ok(canonicalized.extraction.safety_flags.some((item) => item.label.includes("weight gain above 2 kg")));
assert.equal(canonicalCoverage.by_view.safety_flags.expected, 3);
assert.equal(canonicalCoverage.by_view.safety_flags.matched, 3);
assert.equal(canonicalCoverage.by_view.safety_flags.orphaned, 0);

console.log("PASS evaluation strict/relaxed, type-aware safety, and atom coverage diagnostics (37 assertions)");
