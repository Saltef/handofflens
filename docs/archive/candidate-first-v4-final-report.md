# Candidate-first v4 development report

Public-facing note: this report explains why candidate-first v4 is the strongest current engineering architecture. It is a development result, not a clinical validation result.

## Decision

Candidate-first v4 is the leading **high-recall engineering candidate**, but it is not clinically validated and must not be described as more accurate than v2. It improves deterministic provenance, yield, vacuity, and formatting stability. It also produces substantially more items, creating a credible over-extraction risk that automated provenance checks cannot resolve.

The appropriate next step is independent factual review before presenting v4's higher yield as improved accuracy. The current evidence supports architecture selection for further review, not clinical superiority.

## Architecture

1. Collapse formatting into a canonical source representation while preserving original character-offset mappings.
2. Generate stable candidate IDs from normalized content and domain.
3. Parse explicit discharge medication, diagnosis, procedure, laboratory, and follow-up section entries deterministically.
4. Materialize original quotations from immutable offsets; the model never writes quotations or spans.
5. Use the configured instruction model only for ambiguous cue-derived candidates outside explicit sections.
6. Freeze temperature 0, seed 20260622, hidden reasoning budget 512, and zero provider retries.
7. Generate the narrative summary only from accepted evidence.
8. Abstain when no evidence survives the deterministic gate.

## Twenty-case development result

- Full deterministic gate pass: 19/20.
- Explicit abstention: 1/20.
- Recovery calls: 0.
- Candidate overflow: 0.
- Median explicit-section coverage: 1.0.
- Total API calls: 39, or 1.95 per attempted case.
- Recorded tokens: 95,736 input and 27,005 output.
- Sum of recorded API latency: 105.1 seconds.
- Deterministic semantic-warning count: 21.
- Extracted evidence items: 514.

These figures describe the pre-amendment implementation and are retained to explain why the architecture was changed. The final June 23 rerun is the current implementation result.

On the same cases, evidence-span v2 passed 14/20 and produced 202 items. Paired gate outcomes were 13 both-pass, 6 v4-only, 1 v2-only, and 0 neither-pass.

These paired outcomes support an engineering reliability claim only. The increase from 202 to 514 items may reflect recovered omissions, over-extraction, or both.

## Stability

Candidate IDs were identical across all 20 records after whitespace normalization and complete rewrapping.

Across five live whitespace-perturbation cases:

- deterministic explicit-section core mean/minimum Jaccard: 1.0/1.0;
- complete selected-evidence mean Jaccard: 0.914;
- complete selected-evidence minimum Jaccard: 0.733.

A fixed provider seed did not make ambiguous model selection fully deterministic. Stability comes primarily from removing explicit-section evidence from generative selection.

## Known limitations

- Explicit-section membership establishes provenance and context, not necessarily the correct normalized category.
- Medication-list presence supports current-at-discharge status, but does not by itself establish that a medication was newly started.
- Deterministic labels preserve source wording and may be verbose or insufficiently normalized.
- Ambiguous candidate selection can still mishandle totals, timing, subject, dose, route, frequency, or negation even though final labels are now materialized extractively.
- Automated section coverage is a weak-reference measure, not completeness ground truth.
- Twenty-one deterministic semantic warnings remain.
- The 20 cases are repeatedly inspected development data; all estimates are descriptive.

## Post-review amendment

A manual spot check found that some plausible label details were not fully supported by the displayed quotation and that one quotation ended at an artificial `??????` boundary. The implementation was amended to:

- treat `??????` as a bullet boundary;
- materialize final labels from source candidates instead of free-form model text;
- add quote-completeness and transformation-type fields to the factual-review rubric.

The affected case, `CASE_00107`, was rerun and passed the deterministic gate. Deterministic rematerialization of the saved 20-case output produced 505 items. A final June 23 development rerun with the amended pipeline passed deterministic gates on 19 of 20 cases, with one explicit abstention and no stage failures.

## Next validation step

Review a blinded sample of v2-only, v4-only, and shared evidence items for factual entailment and duplication. A non-clinician factual reviewer can assess whether the quote supports the label and whether repeated items represent the same fact. Clinical importance and safety remain outside scope.

Until that review exists, retain both outputs:

- v2 as the conservative candidate;
- v4 as the high-recall candidate.

Do not select between them using the held-out 400.

