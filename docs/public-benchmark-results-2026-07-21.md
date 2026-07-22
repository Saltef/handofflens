# Public Benchmark Run Results - 2026-07-22

This note records the public benchmark execution after the profile/adapter and Docker refactor. It contains aggregate results only; no downloaded corpus files or case-level records are committed.

## Data Access

- ACI-Bench was downloaded from the public GitHub JSON files under CC BY 4.0. All 30 public challenge JSON files were ingested: train, validation, three held-out challenge splits, their `_full` aliases, and four section-specific files for each split.
- BioScope was downloaded from the public BioScope corpus zip for research use.
- i2b2 and n2c2 datasets were not present locally and remain DUA-gated. No i2b2/n2c2 scores are claimed here.

## ACI-Bench Ingestion and Note-Shape Diagnostic

ACI-Bench JSON records contain `src` conversations, `tgt` expert reference notes, and `file` ids. The adapter maps those fields into HandoffLens benchmark records as `source_text`, `reference_text`, and stable ids. A separate note-generation scorer computes ROUGE-1, ROUGE-2, ROUGE-L, token counts, compression ratio, and case-bootstrap confidence intervals.

The current run scores the source transcript (`src`) against the reference note (`tgt`). This is a task-shape baseline and ingestion check, not a model note-generation result. It answers: after ingesting the complete public JSON corpus, how much lexical overlap exists between the conversation and expert note before any summarizer is applied?

Canonical full-note splits:

| Split | Records | Mean source tokens | Mean reference tokens | Compression ratio | ROUGE-1 F1 | ROUGE-2 F1 | ROUGE-L F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| train | 67 | 1,189.1 | 421.4 | 2.97 | 0.3318 [0.3155, 0.3483] | 0.1292 [0.1170, 0.1412] | 0.1946 [0.1815, 0.2081] |
| valid | 20 | 1,133.0 | 433.3 | 2.81 | 0.3484 [0.3192, 0.3776] | 0.1418 [0.1180, 0.1658] | 0.2053 [0.1837, 0.2270] |
| clinicalnlp_taskB_test1 | 40 | 1,140.1 | 415.9 | 2.91 | 0.3349 [0.3122, 0.3572] | 0.1275 [0.1114, 0.1430] | 0.1916 [0.1745, 0.2094] |
| clinicalnlp_taskC_test2 | 40 | 1,281.8 | 437.6 | 3.02 | 0.3295 [0.3055, 0.3529] | 0.1329 [0.1151, 0.1532] | 0.1963 [0.1756, 0.2183] |
| clef_taskC_test3 | 40 | 1,239.3 | 438.8 | 2.91 | 0.3342 [0.3132, 0.3561] | 0.1303 [0.1147, 0.1455] | 0.1940 [0.1767, 0.2103] |

Section-file aggregate means across the five public split families:

| Section | Files | Records | Mean ROUGE-1 F1 | Mean ROUGE-L F1 |
| --- | ---: | ---: | ---: | ---: |
| assessment_and_plan | 5 | 207 | 0.1710 | 0.1043 |
| subjective | 5 | 207 | 0.1749 | 0.1051 |
| objective_exam | 5 | 207 | 0.0609 | 0.0469 |
| objective_results | 5 | 207 | 0.0234 | 0.0189 |

Interpretation: the full-note transcript/reference baseline is stable across train, validation, and held-out public splits. Section files have much lower lexical overlap because each reference section compresses and normalizes a narrow portion of the dialogue. That is useful engineering evidence for the next ACI step: model note generation should be scored with summarization metrics and factuality/source-support checks, while item extraction should use explicit item-level gold rather than note-derived pseudo-items.

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

Interpretation: current `clinical-dialogue` candidate extraction does not align well with note-derived targets. The gap is expected because conversation evidence and clinical-note wording are not section-isomorphic. This argues for an ACI-specific transformation layer or an official note-generation metric, not for presenting these as item-level extraction benchmark scores.

## BioScope Assertion Benchmark

BioScope XML includes gold negation/speculation cues and scopes. The evaluator collapses sentence labels to:

- `absent` for negation cues;
- `possible` for speculation cues;
- `present` for unmarked sentences.

The public clinical XML is lexically redacted with `*`, so it is not a fair cue-word benchmark for a lexical assertion detector. The fair public-text headline below uses `abstracts.xml` plus `full_papers.xml`.

| Corpus slice | Sentences | Accuracy | Macro-F1 | Present F1 | Absent F1 | Possible F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| abstracts + full papers | 14,541 | 0.8955 | 0.8326 | 0.9360 | 0.7642 | 0.7977 |
| all XML, including redacted clinical | 20,924 | 0.8528 | 0.7336 | 0.9100 | 0.6066 | 0.6842 |

BioScope public-text per-class intervals:

| Class | Precision | Precision 95% CI | Recall | Recall 95% CI | F1 |
| --- | ---: | --- | ---: | --- | ---: |
| present | 0.9170 | [0.9116, 0.9220] | 0.9559 | [0.9518, 0.9597] | 0.9360 |
| absent | 0.8796 | [0.8597, 0.8969] | 0.6756 | [0.6517, 0.6985] | 0.7642 |
| possible | 0.8110 | [0.7953, 0.8258] | 0.7847 | [0.7686, 0.8000] | 0.7977 |

Interpretation: the expanded uncertainty cue vocabulary materially improves speculation detection while preserving existing tests. Remaining weakness is negation recall, especially nonlocal or structurally scoped negation.

## BioScope Conformal Assertion Layer

The benchmark path now includes a split-conformal wrapper for BioScope assertion labels:

```bash
npm run benchmark:bioscope:conformal -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --alpha 0.10 --out <bioscope-conformal-public-text.json>
```

What it measures:

- A transparent lexical score is assigned to each assertion label: `present`, `absent`, and `possible`.
- A document-hash split separates calibration examples from held-out test examples when document ids are available.
- The calibration split chooses a conformal nonconformity threshold for the requested alpha.
- Test examples receive prediction sets. Singleton sets are accepted; multi-label sets are abstentions/escalations.

The resulting report includes target coverage, empirical held-out coverage, prediction-set size, singleton acceptance rate, abstention rate, accepted accuracy, and class-conditional coverage. The runner reports both a pooled global conformal threshold and a label-conditional threshold.

Public-text BioScope conformal run at alpha 0.10:

| Method | Test sentences | Empirical coverage | Mean set size | Singleton accept rate | Abstention rate | Accepted accuracy | Present coverage | Absent coverage | Possible coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Global split conformal | 7,606 | 0.9105 | 1.022 | 0.9780 | 0.0220 | 0.9095 | 0.9556 | 0.7888 | 0.8053 |
| Label-conditional split conformal | 7,606 | 0.9511 | 2.452 | 0.2648 | 0.7352 | 0.7726 | 0.9488 | 0.9488 | 0.9613 |

Calibration/test split: document-hash split, 6,935 calibration sentences across 641 documents and 7,606 test sentences across 641 documents.

This is a useful reliability layer for the BioScope assertion subtask, but it should be read narrowly. It controls marginal prediction-set coverage under the exchangeability assumption for the calibration/test split. It does not provide conditional per-class guarantees, does not repair scope-boundary errors, and does not establish clinical safety. The main trade-off is yield: stronger coverage targets generally increase abstention and reduce the fraction of automatically accepted assertion labels.

Interpretation: the global threshold is operationally attractive because it preserves high singleton yield and improves accepted accuracy relative to the hard-label baseline on the held-out split, but it badly undercovers the minority `absent` and `possible` classes. The label-conditional threshold fixes that coverage gap, but only by returning large prediction sets and abstaining on most examples. For safety-facing clinical use, the label-conditional result is the more honest coverage audit; for automation, neither result is sufficient without a stronger calibrated assertion model.

ACI-Bench is intentionally not conformalized in the current public report. The existing ACI path is a reference-derived alignment diagnostic rather than the native ACI-Bench note-generation task. Conformal prediction should be added to ACI only after the benchmark is reframed around note generation or a well-defined claim-support task; otherwise the conformal layer would calibrate the wrong target.

## Commands Run

```bash
npm run benchmark:adapt:aci -- --input <aci-json-file> --split <split-name> --out <split-records.json>
npm run benchmark:score:aci-note -- --records <split-records.json> --prediction-field src --bootstrap-repeats 1000 --out <split-note-score.json>
npm run benchmark:derive-reference-gold -- --records <split-records.json> --out <split-reference-gold.json>
npm run benchmark:predict:candidates -- --records <split-records.json> --out <split-predictions.json>
npm run benchmark:score -- --records <split-reference-gold.json> --predictions <split-predictions.json> --bootstrap-repeats 1000 --out <split-item-score.json>
npm run benchmark:bioscope -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --out <bioscope-assertions-public-text-v2.json>
npm run benchmark:bioscope:conformal -- --input <bioscope>/abstracts.xml;<bioscope>/full_papers.xml --alpha 0.10 --out <bioscope-conformal-public-text.json>
```

## Non-Claims

- These ACI numbers are not official ACI-Bench summarization scores.
- These ACI numbers are not native expert entity-extraction F1.
- The ACI note-shape baseline is not a HandoffLens model-generation score.
- ACI conformal prediction is not claimed until the ACI task is reframed around note generation or claim-level source support.
- BioScope scores evaluate sentence-level assertion cue classification, not exact scope-boundary extraction.
- BioScope conformal coverage is marginal prediction-set coverage for the assertion subtask, not clinical safety coverage.
- No i2b2 or n2c2 result is claimed without DUA-controlled data.
