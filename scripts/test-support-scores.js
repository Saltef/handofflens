"use strict";

// Offline regression guard for the bake-off support scores. Pins the behavior
// the bake-off depends on: lexical is fooled by cue-marked AND subtle
// distractors; cue-aware catches cue-marked ones but is still fooled by subtle
// ones (motivating the entailment arm). No model calls.

const assert = require("node:assert");
const { lexical, cueAware } = require("./support-scores");
const { buildCase } = require("./generate-synthetic-gold");

function run() {
  const c = buildCase(0);
  const present = c.gold[0];
  const negated = c.distractors.find((d) => d.kind === "negated");
  const historical = c.distractors.find((d) => d.kind === "historical");
  const subtle = c.distractors.find((d) => d.subtle);
  const failures = [];

  const check = (name, cond) => { if (!cond) failures.push(name); };

  // Present fact: both scores high.
  check("lexical high on present", lexical(present.normalized_value, present.gold_sentence) >= 0.8);
  check("cue_aware high on present", cueAware(present.normalized_value, present.gold_sentence) >= 0.8);

  // Cue-marked distractors: lexical fooled (value in quote), cue-aware catches.
  check("lexical fooled by negated", lexical(negated.value, negated.text) >= 0.8);
  check("cue_aware catches negated", cueAware(negated.value, negated.text) === 0);
  check("cue_aware catches historical", cueAware(historical.value, historical.text) === 0);

  // Subtle distractor: BOTH fooled (no cue word) -> only entailment can catch it.
  check("lexical fooled by subtle", lexical(subtle.value, subtle.text) >= 0.8);
  check("cue_aware fooled by subtle", cueAware(subtle.value, subtle.text) >= 0.8);

  if (failures.length) {
    console.error("FAIL: support-score guard");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exitCode = 1;
    return;
  }
  console.log("PASS: support-score guard");
  console.log("  lexical: fooled by cue-marked AND subtle distractors (value-in-quote)");
  console.log("  cue_aware: catches cue-marked distractors (->0), still fooled by subtle");
  console.log("  => subtle assertion errors require the entailment score");
}

run();
