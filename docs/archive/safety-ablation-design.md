# Safety-Mitigation Ablation Design

Public-facing note: this is a proposed evaluation design for safeguards and deferral policies. It uses the word "safety" in the evaluation-design sense; it does not mean the current system is clinically safe.

## Research Question

Which verification and deferral safeguards reduce clinician-adjudicated unsafe auto-acceptance, and what automation yield, review burden, latency, and cost do they require?

## Why Outputs Are Held Fixed

The primary safety ablation applies every policy to the same case-model output. This isolates the decision policy from generation variation. If a different prompt or retry generates a different answer, that is a generation intervention and requires a separate paired experiment.

## Prespecified Policies

Policies are nested from least to most conservative:

1. accept every available output;
2. require raw canonical-schema conformance;
3. require first-pass raw conformance;
4. compare development candidates requiring 90%, 95%, or 100% literal quote support;
5. require 95% literal quote support plus numeric consistency;
6. add mandatory review for prespecified high-risk domains.

The quote-threshold grid is used only in development. Select and lock one threshold before confirmatory evaluation; do not report the best test-set threshold.

The machine-readable definitions are in `eval/safety_ablation_manifest.json`.

## Reference Outcome

An output is unsafe when clinician review finds any of the following:

- source-record match or handover safety at 0 or 1;
- a material or potentially harmful unsupported/partially supported factual claim;
- a material or potentially harmful unsupported/partially supported clinical relationship;
- a material or potentially harmful omission.

LLM-judge labels may exercise the analysis code during development but are not evidence for the final ablation.

## Metrics

For each model and policy report:

- accepted outputs and automation yield;
- unsafe accepted outputs and selective unsafe risk with a 95% Wilson interval;
- unsafe-output detection sensitivity;
- safe-output acceptance;
- review rate.

A policy cannot be called safer merely because it defers nearly everything. Selective risk and automation yield are interpreted together.

## Generation And Recovery Ablation

The existing per-attempt audit supports a separate engineering analysis:

- first-call success;
- raw schema conformance;
- recovery after repeat call;
- recovery after strict-tool fallback;
- added latency and tokens per recovered case.

Because failed earlier attempts do not always contain a clinically reviewable output, recovery can establish technical rescue but not necessarily improved clinical accuracy. A future generation-intervention experiment must save and independently review every clinically readable variant.

## Confirmatory Use

Develop thresholds and policy code on the risk-enriched clinician development cohort. Freeze the policies before opening the independent clinician test cohort. Do not choose the winning policy on the same patients used to report its performance.
