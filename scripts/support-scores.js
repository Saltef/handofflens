"use strict";

// Candidate nonconformity/support scores for the conformal bake-off. Each maps a
// (claim value, evidence quote) pair to [0,1], higher = better supported. The CRC
// harness (conformal-risk-control.js) then calibrates a threshold per score.

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s./]/g, " ").replace(/\s+/g, " ").trim(); }
function tokens(s) { return norm(s).split(" ").filter(Boolean); }

// 1. Lexical: token coverage of the value by the quote. Blind to assertion.
function lexical(value, quote) {
  const v = tokens(value); if (!v.length) return 0;
  const q = new Set(tokens(quote));
  return v.filter((t) => q.has(t)).length / v.length;
}

// Template assertion cues (deterministic, brittle by design).
const CUE = /\b(not|no|denies?|without|negative|never|history of|prior|previously|discontinued|since stopped|if|should|when|as needed|prn)\b/;

// 2. Cue-aware: lexical, hard-gated to 0 when the quote carries a negation /
// historical / conditional cue word. Catches template distractors; misses
// paraphrased ones that avoid the cue list.
function cueAware(value, quote) {
  if (CUE.test(norm(quote))) return 0;
  return lexical(value, quote);
}

module.exports = { lexical, cueAware, CUE, tokens, norm };
