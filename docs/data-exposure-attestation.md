# Data Exposure Attestation

Recorded: 2026-06-18

Public-facing note: this attestation explains the boundary between development exposure and independent validation. It is included to make the evidence limitations visible without exposing source records.

## User Statement

The dataset was not reviewed by a human. All cases were processed by a bulk model extraction run. Subsequent review artifacts were produced by LLM judges, not clinicians or other human reviewers.

## Repository Verification

- No completed clinician-review or adjudication artifact exists under `results/`.
- The prepared clinician packet has no `reviewer_id` and therefore is not a completed review.
- Populated atomic-review artifacts identify the reviewer as `LLM_JUDGE:openai/gpt-5-mini`.
- Other judge artifacts identify GPT-5-mini, GPT-5.2, and one Claude Sonnet patch as automated judges.
- The repository contains LLM-judge labels for a union of 75 cases, prepared review/subset artifacts for 50 cases, routing/proxy analyses involving up to 500 cases, and failure analysis involving 17 cases. These categories overlap.
- All 2,000 cases were processed by the bulk extraction run.

## Exposure Decision

Cases appearing in any judge, prepared-review subset, routing/proxy, failure-analysis, model-comparison, or case-specific configuration-development artifact are conservatively classified as direct/proxy development. This union contains 521 cases.

The remaining 1,479 cases have bulk extraction exposure only. After excluding subjects and near-duplicate clusters overlapping the 521 development cases, 1,399 independent subject/cluster units remain eligible for a locked retrospective clinician validation.

## Interpretation Boundary

The clinician endpoint remains unseen for the eligible cases. This permits internal validation of the frozen system against new clinician labels. It does not provide external-site validation, temporal validation, or an unbiased comparison of every configuration considered during development. LLM-judge results remain development proxies and cannot be reported as clinician evidence.
