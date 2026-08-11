# Support-Score Bake-off Under Conformal Risk Control — Results

Experiment ID: `support-score-bakeoff-v1`
Pre-registration: `docs/preregistration-bakeoff-experiment.md`
Run: 2026-08-11. 600 construction-true (value, quote, label) pairs from 60
synthetic cases (300 supported, 300 unsupported: 180 cue-marked distractors +
120 subtle cue-free distractors). Entailment judge: Cohere Command A+, thinking
disabled. Aggregates only; raw judge outputs local/uncommitted.

## Score discrimination by item kind (mean, higher = looks supported)

Entailment score is the Command A+ judge v2 (schema-aligned definition, five
calibration examples in phrasings that differ from the evaluation templates, so a
correct verdict reflects generalizing the definition, not template matching).

| kind | n | lexical | cue-aware | entailment (judge v2) |
| --- | ---: | ---: | ---: | ---: |
| present | 300 | 0.956 | 0.956 | 1.000 |
| negated | 60 | 1.000 | 0.000 | 0.000 |
| historical | 60 | 1.000 | 0.000 | 0.000 |
| conditional | 60 | 1.000 | 0.000 | 0.000 |
| subtle_held | 60 | 1.000 | 1.000 | 0.000 |
| subtle_completed | 60 | 1.000 | 1.000 | 0.000 |

- **Lexical** is fooled by every distractor (value is in the quote).
- **Cue-aware** catches the three cue-marked kinds (-> 0) but is still fooled by
  the two subtle kinds (no cue word).
- **Entailment (Command A+)** separates every distractor kind, including the
  subtle paraphrased ones, while affirming all present facts — perfect separation
  on this slice.

## Conformal bake-off (case-clustered, 200 splits)

| alpha | lexical coverage | cue-aware coverage | entailment coverage | entailment realized risk |
| ---: | ---: | ---: | ---: | ---: |
| 0.05 | 0.000 | 0.000 | 0.500 | 0.000 |
| 0.10 | 0.000 | 0.000 | 0.500 | 0.000 |
| 0.20 | 0.000 | 0.059 | 0.500 | 0.000 |

Entailment wins at every alpha and accepts the entire supported set (0.500 = the
supported base rate) at zero realized false-support risk. Lexical and cue-aware
cannot separate the subtle distractors from real facts at any threshold, so CRC
must reject almost everything to hold the risk target. CRC validity holds for all
scores.

## The finding — the ceiling was task specification, not the model

A first judge (v1) with a narrow "current active fact" definition had perfect
precision but only 0.185 coverage: it scored ~63% of **true** present facts as 0
(admission labs, future follow-ups, held meds). That located the ceiling as the
judge's task definition, not conformal or the model. Aligning the definition to
"affirmed as a real, applicable item for this admission" and adding five
cross-phrasing calibration examples (judge v2) lifted Command A+ to perfect
separation: every present fact affirmed, every distractor rejected, coverage
0.500 at zero risk.

So the useful reading is not "conformal is limited" — it is that **Command A+ is a
strong grounding verifier once the support task is specified**, catching
negation, conditionality, historical framing, and paraphrased held/discontinued
distractors that lexical and cue-based scores cannot. The before/after (v1 -> v2)
is itself the lesson: judge definition, not model capability, was the constraint.

## Interpretation

- Ranking is unambiguous: entailment > cue-aware > lexical for support-decision
  discrimination under a fixed risk budget, and only entailment survives the
  subtle assertion errors.
- The result also shows why a guarantee is not enough on its own: CRC bounds the
  false-support rate for any score, but the useful score is the one that delivers
  the bound at high coverage. Here that is entailment, but a stricter/miscalibrated
  judge trades coverage away.

## Claim boundary

Synthetic adversarial pool (50/50 supported/unsupported), construction-true
labels, a single judge model. Ranks scores and exposes the judge-recall ceiling;
it is not real clinical support detection, not adjudicated recall, and the
absolute coverage numbers are depressed by the adversarial base rate. The
entailment judge is a model estimate, not ground truth. A real deployment must
recalibrate the winning score on human-labeled data before claiming a bound for
the real setting.
