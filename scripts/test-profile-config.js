const assert = require("node:assert/strict");
const { compileProfile, listProfileFiles, loadProfile, validateProfile } = require("./profile-config");
const { generateCandidates } = require("./candidate-first-index");
const { expandKnownTerms } = require("./typed-provenance");

const files = listProfileFiles();
assert.ok(files.length >= 2, "expected at least two public profiles");

for (const file of files) {
  const profile = loadProfile(file);
  assert.deepEqual(validateProfile(profile), [], `${profile.profile_id} should validate`);
  const compiled = compileProfile(profile);
  assert.ok(compiled.headings.length >= 1, `${profile.profile_id} should compile headings`);
  assert.ok(Object.keys(compiled.cues).length >= 5, `${profile.profile_id} should expose core domains`);
}

const discharge = generateCandidates([
  "DISCHARGE MEDICATIONS:",
  "1. Aspirin 81 mg daily.",
  "DISCHARGE DIAGNOSES:",
  "1. Pneumonia.",
  "PERTINENT RESULTS:",
  "Potassium was low and creatinine improved.",
  "FOLLOW-UP:",
  "Follow up in clinic within one week."
].join("\n"), { profileId: "discharge-summary" });

assert.equal(discharge.profile_id, "discharge-summary");
assert.equal(discharge.detected_domains.medication_changes, true);
assert.equal(discharge.detected_domains.labs, true);
assert.equal(discharge.detected_domains.follow_up_actions, true);

const dialogue = generateCandidates([
  "Doctor: We stopped lisinopril because the creatinine rose.",
  "Patient: When should I come back?",
  "Doctor: Follow up in cardiology within one week and repeat blood work."
].join(" "), { profileId: "clinical-dialogue" });

assert.equal(dialogue.profile_id, "clinical-dialogue");
assert.equal(dialogue.detected_domains.medication_changes, true);
assert.equal(dialogue.detected_domains.follow_up_actions, true);

assert.equal(expandKnownTerms("AKI").includes("acute kidney injury"), true);
assert.equal(expandKnownTerms("PE").includes("pulmonary embolism"), false, "ambiguous PE must not be silently expanded");

console.log("PASS profile config validation");
