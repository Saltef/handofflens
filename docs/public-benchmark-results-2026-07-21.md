# Public Benchmark Run Results - 2026-07-22

This note records the current public benchmark execution after the benchmark, Docker, and assertion-baseline refactor. It contains aggregate results only. No downloaded corpus files, raw case records, private provider outputs, API keys, or reviewer packets are committed.

## Data Access

- ACI-Bench was downloaded from the public GitHub JSON files under CC BY 4.0. All 30 public challenge JSON files were ingested: train, validation, three held-out challenge splits, their `_full` aliases, and four section-specific files for each split.
- BioScope was downloaded from the public BioScope corpus zip for research use.
- i2b2 and n2c2 datasets were not present locally and remain DUA-gated. No i2b2/n2c2 scores are claimed here.

## ACI-Bench Note Generation

ACI-Bench JSON records contain `src` conversations, `tgt` expert reference notes, and `file` ids. The adapter maps those fields into HandoffLens benchmark records as `source_text`, `reference_text`, and stable ids. The note-generation scorer computes ROUGE-1, ROUGE-2, ROUGE-L, token counts, compression ratio, and case-bootstrap confidence intervals.

The transcript/reference baseline scores the full source transcript (`src`) against the reference note (`tgt`). This is an ingestion and task-shape diagnostic, not a generated-note model score.

Canonical full-note transcript/reference baseline:

| Split | Records | Mean source tokens | Mean reference tokens | Compression ratio | ROUGE-1 F1 | ROUGE-2 F1 | ROUGE-L F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| train | 67 | 1,189.1 | 421.4 | 2.97 | 0.3318 [0.3155, 0.3483] | 0.1292 [0.1170, 0.1412] | 0.1946 [0.1815, 0.2081] |
| valid | 20 | 1,133.0 | 433.3 | 2.81 | 0.3484 [0.3192, 0.3776] | 0.1418 [0.1180, 0.1658] | 0.2053 [0.1837, 0.2270] |
| clinicalnlp_taskB_test1 | 40 | 1,140.1 | 415.9 | 2.91 | 0.3349 [0.3122, 0.3572] | 0.1275 [0.1114, 0.1430] | 0.1916 [0.1745, 0.2094] |
| clinicalnlp_taskC_test2 | 40 | 1,281.8 | 437.6 | 3.02 | 0.3295 [0.3055, 0.3529] | 0.1329 [0.1151, 0.1532] | 0.1963 [0.1756, 0.2183] |
| clef_taskC_test3 | 40 | 1,239.3 | 438.8 | 2.91 | 0.3342 [0.3132, 0.3561] | 0.1303 [0.1147, 0.1455] | 0.1940 [0.1767, 0.2103] |

### Extractive Generated-Note Baselines

The new ACI baseline runner evaluates compressed deterministic note candidates, then scores both ROUGE and lexical source support. `source_full` remains visible as a diagnostic baseline, but the selected method must be a compressed generated-note baseline.

Methods:

- `lead_reference_length`: first source tokens up to the reference-note token count.
- `tail_reference_length`: final source tokens up to the reference-note token count.
- `cue_sentence_extractive`: source sentences with medication, follow-up, result, assessment, and procedure cues up to the reference-note token count.
- `source_full`: full transcript diagnostic only.

Canonical full-note compressed baseline result:

| Split | Selected compressed method | Records | ROUGE-1 F1 | ROUGE-2 F1 | ROUGE-L F1 | Source-full ROUGE-L F1 | Mean generated tokens | Source token support |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| train | tail_reference_length | 67 | 0.3632 | 0.1126 | 0.1863 | 0.1946 | 421.4 | 1.000 |
| valid | tail_reference_length | 20 | 0.3895 | 0.1340 | 0.2023 | 0.2053 | 433.3 | 1.000 |
| clinicalnlp_taskB_test1 | tail_reference_length | 40 | 0.3545 | 0.1027 | 0.1725 | 0.1916 | 416.0 | 1.000 |
| clinicalnlp_taskC_test2 | tail_reference_length | 40 | 0.3692 | 0.1113 | 0.1781 | 0.1963 | 437.6 | 1.000 |
| clef_taskC_test3 | tail_reference_length | 40 | 0.3668 | 0.1131 | 0.1827 | 0.1940 | 438.8 | 1.000 |

Section-file aggregate means across the five public split families:

| Section | Files | Best compressed method pattern | Mean selected ROUGE-L F1 | Mean source-full ROUGE-L F1 |
| --- | ---: | --- | ---: | ---: |
| assessment_and_plan | 5 | tail_reference_length: 5/5 | 0.2027 | 0.1043 |
| subjective | 5 | lead_reference_length: 5/5 | 0.1806 | 0.1051 |
| objective_exam | 5 | cue_sentence_extractive: 5/5 | 0.1055 | 0.0469 |
| objective_results | 5 | cue_sentence_extractive: 3/5; tail_reference_length: 2/5 | 0.0584 | 0.0189 |

Interpretation: for full-note ACI files, the final reference-length slice is the strongest compressed deterministic baseline. It is close to the full-transcript ROUGE-L baseline, has higher ROUGE-1, and stays lexically source-supported. For section files, the best baseline changes by section: subjective content is early, assessment/plan content is late, and objective sections benefit from cue-based extraction. A model-based ACI result should beat these simple baselines while preserving source support. If it cannot, the model path is not adding enough value.

Trade-off: extractive baselines have excellent lexical groundedness by construction, but they are not clinically adequate notes. They copy source wording, cannot normalize or reorganize like an expert note, and ROUGE does not establish factual correctness.

### Command A+ Generated Notes and Attribution Repair

Command A+ was run over the five canonical full-note ACI splits (`207/207` rows completed). The run used the public ACI `src` conversation only as model input and scored generated notes against the expert `tgt` note. Provider outputs and raw rows are kept outside the public repo.

The model-generated notes beat the compressed deterministic baselines on ROUGE, but had weak lexical source support by the repository's current source-support proxy. This does not prove hallucination: a concise clinical paraphrase can be correct while lexically novel. It does, however, show why citation-level or schema-level validity alone is too weak for a source-grounded clinical handoff system.

An attribution-repair diagnostic was then run over the same generated notes. The selected repair method, `compact_extractive`, uses the model note as a salience query, replaces generated sentences with compact source-token spans, and ranks repair methods by scored-case coverage, source-token support, token balance, then ROUGE. Reference notes are used only for scoring, not for content selection.

Aggregate full-note results across train, validation, and the three public held-out split files:

| Method | Cases | ROUGE-1 F1 | ROUGE-2 F1 | ROUGE-L F1 | Source token support | Source bigram support | Unsupported-sentence case rate | Mean prediction tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Command A+ generated note | 207 | 0.4355 | 0.1651 | 0.2550 | 0.6945 | 0.2201 | 1.0000 | 250.6 |
| `compact_extractive` attribution repair | 207 | 0.4078 | 0.1576 | 0.2324 | 1.0000 | 0.9344 | 0.2464 | 435.9 |
| `tail_reference_length` extractive baseline | 207 | 0.3659 | 0.1126 | 0.1829 | 1.0000 | 1.0000 | 0.0000 | 428.0 |
| `source_full` transcript baseline | 207 | 0.3340 | 0.1310 | 0.1953 | 1.0000 | 1.0000 | 0.0000 | 1,201.8 |

Interpretation: the best current public design is not plain model generation and not pure extraction. It is a two-stage, source-grounded note compiler: use the model for salience and organization, then force the final auditable artifact through compact source-span repair. This improves substantially over deterministic extractive baselines while making overstatement measurable. The trade-off is real: ROUGE-L drops from `0.2550` to `0.2324`, and repaired notes remain longer and less polished than the model notes. The unresolved engineering target is semantic source support: compact lexical spans should be replaced or augmented with entailment-backed, assertion-aware evidence atoms before making stronger clinical claims.

## ACI-Bench Reference-Derived Item Alignment

The public JSON does not contain HandoffLens-native item-level `gold_items`, so the item-level scorer was also run as a harness diagnostic:

1. derive item-like targets from the expert `tgt` note with the same profile-based candidate index;
2. predict source-conversation candidates with the clinical-dialogue profile;
3. score exact and relaxed item alignment.

This is a reproducible public alignment diagnostic, not an official ACI-Bench leaderboard metric and not an expert item-extraction F1.

| Split | Records | Reference-derived items | Source candidates | Exact F1 | Relaxed F1 | Relaxed precision | Relaxed recall | F1 bootstrap 95% CI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| valid | 20 | 185 | 190 | 0.000 | 0.016 | 0.0158 | 0.0162 | [0.000, 0.0416] |
| train | 67 | 599 | 640 | 0.000 | 0.0113 | 0.0109 | 0.0117 | [0.0043, 0.0190] |
| clinicalnlp_taskB_test1 | 40 | 331 | 336 | 0.000 | 0.0090 | 0.0089 | 0.0091 | [0.0000, 0.0199] |
| clinicalnlp_taskC_test2 | 40 | 395 | 414 | 0.000 | 0.0000 | 0.0000 | 0.0000 | [0.0000, 0.0000] |
| clef_taskC_test3 | 40 | 397 | 367 | 0.000 | 0.0183 | 0.0191 | 0.0176 | [0.0025, 0.0392] |

Interpretation: current `clinical-dialogue` candidate extraction does not align well with note-derived targets. The gap is expected because conversation evidence and clinical-note wording are not section-isomorphic. This result should not be used as the core extraction claim.

## BioScope Assertion Benchmark

BioScope XML includes gold negation/speculation cues and scopes. The evaluator collapses sentence labels to:

- `absent` for negation cues;
- `possible` for speculation cues;
- `present` for unmarked sentences.

The primary result is now sentence-only: the detector receives sentence text, not BioScope `xcope` text. The previous scope-assisted result is retained only as a diagnostic because it gives the detector gold-derived scope text.

| Corpus slice / target mode | Sentences | Accuracy | Macro-F1 | Present F1 | Absent F1 | Possible F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| abstracts + full papers, sentence-only | 14,541 | 0.9254 | 0.8821 | 0.9553 | 0.8461 | 0.8451 |
| abstracts + full papers, scope-assisted diagnostic | 14,541 | 0.8955 | 0.8326 | 0.9360 | 0.7642 | 0.7977 |
| redacted clinical XML, sentence-only diagnostic | 6,383 | 0.7556 | 0.2869 | 0.8608 | 0.0000 | 0.0000 |

The redacted clinical XML is not a valid clinical assertion benchmark for this lexical detector. The cue-bearing clinical text is masked with `*`, so all transparent methods collapse to majority-class behavior.

BioScope public-text sentence-only per-class intervals:

| Class | Precision | Precision 95% CI | Recall | Recall 95% CI | F1 |
| --- | ---: | --- | ---: | --- | ---: |
| present | 0.9380 | [0.9333, 0.9424] | 0.9732 | [0.9699, 0.9762] | 0.9553 |
| absent | 0.8699 | [0.8516, 0.8862] | 0.8235 | [0.8036, 0.8417] | 0.8461 |
| possible | 0.9014 | [0.8886, 0.9129] | 0.7954 | [0.7795, 0.8104] | 0.8451 |

### Same-Task Baselines

The same collapsed BioScope task was run against transparent baselines:

| Method | Accuracy | Macro-F1 | Absent recall | Possible recall | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| present_majority | 0.7143 | 0.2778 | 0.0000 | 0.0000 | Dominant-class anchor. |
| negex_style | 0.7975 | 0.5587 | 0.8502 | 0.0000 | Negation-only cue baseline; no uncertainty class. |
| handofflens_assertion | 0.9254 | 0.8821 | 0.8235 | 0.7954 | Hybrid detector: sentence-level cue front end for sentence benchmarks, target-aware context checks for extracted item quotes. |
| context_style | 0.9255 | 0.8823 | 0.8235 | 0.7954 | Transparent ConText-style cue baseline, not official pyConTextNLP. |

Interpretation: the assertion layer is now hybrid. On sentence-level BioScope-style inputs it behaves like the transparent ConText-style cue comparator, closing the previous negation-recall gap. On extracted clinical item quotes, it preserves HandoffLens' target-aware checks for family history, historical conditions, conditional precautions, and assertion conflicts. This is an improvement over the previous detector, but it is still not an official BioScope scope-boundary result and not in-domain clinical-note validation.

Trade-off: the ConText-style baseline is stronger on this adjacent-domain cue task because BioScope labels are cue-driven. It may over-trigger in clinical notes with pseudo-negation, templated lists, family history, historical context, or multiple findings in the same sentence. It should improve the assertion detector, not replace source-grounded item review.

## BioScope Conformal Assertion Layer

The split-conformal wrapper was rerun in sentence-only mode at alpha 0.10:

| Method | Test sentences | Empirical coverage | Mean set size | Singleton accept rate | Abstention rate | Accepted accuracy | Present coverage | Absent coverage | Possible coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Global split conformal | 7,606 | 0.9097 | 1.066 | 0.9336 | 0.0664 | 0.9072 | 0.9556 | 0.8088 | 0.7895 |
| Label-conditional split conformal | 7,606 | 0.9508 | 2.456 | 0.2637 | 0.7363 | 0.6715 | 0.9488 | 0.9500 | 0.9592 |

Hard-label held-out baseline: accuracy 0.8654, macro-F1 0.7715.

Interpretation: the global threshold is operationally attractive but undercovers minority assertion classes. Label-conditional conformal calibration repairs the minority-class coverage problem, but abstains on most examples. For HandoffLens, this supports using conformal sets as an audit/escalation layer, not as a stand-alone safety guarantee.

## Commands Run

```bash
npm run benchmark:adapt:aci -- --input <aci-json-file> --split <split-name> --out <split-records.json>
npm run benchmark:score:aci-note -- --records <split-records.json> --prediction-field src --bootstrap-repeats 1000 --out <split-note-score.json>
npm run benchmark:aci-note:baselines -- --records <split-records.json> --split <split-name> --bootstrap-repeats 1000 --out <split-aci-note-baseline-comparison.json>
npm run benchmark:aci-note:cohere -- --records <split-records.json> --split <split-name> --model command-a-plus-05-2026 --resume --out <split-command-a-plus-note-eval.json>
npm run benchmark:aci-note:repair -- --input <split-command-a-plus-note-eval.json> --split <split-name> --out <split-attribution-repair.json>
npm run benchmark:derive-reference-gold -- --records <split-records.json> --out <split-reference-gold.json>
npm run benchmark:predict:candidates -- --records <split-records.json> --out <split-predictions.json>
npm run benchmark:score -- --records <split-reference-gold.json> --predictions <split-predictions.json> --bootstrap-repeats 1000 --out <split-item-score.json>
npm run benchmark:bioscope -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --target-mode sentence --out <bioscope-assertions-public-text-sentence.json>
npm run benchmark:bioscope:baselines -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --target-mode sentence --out <bioscope-baselines-public-text-sentence.json>
npm run benchmark:bioscope:conformal -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --target-mode sentence --alpha 0.10 --out <bioscope-conformal-public-text-sentence.json>
```

## Non-Claims

- These ACI numbers are not official ACI-Bench model-generation leaderboard scores.
- The compressed ACI baselines are not clinically adequate notes.
- The Command A+ and attribution-repair numbers are benchmark-shaped diagnostics, not official ACI-Bench leaderboard submissions.
- Lexical source support is not semantic entailment; high source-token support can still miss clinical meaning, negation, or temporal scope.
- The ACI item-alignment numbers are not native expert entity-extraction F1.
- BioScope scores evaluate a collapsed sentence-level assertion cue task, not exact scope-boundary extraction.
- The BioScope 0.8326 scope-assisted diagnostic must not be used as the primary assertion result.
- The public BioScope text result is adjacent-domain biomedical literature, not in-domain clinical-note validation.
- The redacted BioScope clinical XML result is a data-redaction diagnostic, not clinical assertion performance.
- BioScope conformal coverage is marginal prediction-set coverage for the assertion subtask, not clinical safety coverage.
- The small transformer comparator was not run because no suitable local model/runtime was available in the public repo.
- No i2b2 or n2c2 result is claimed without DUA-controlled data.
