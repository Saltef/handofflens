# Experiment History and Decision Ledger

This ledger records successful, unsuccessful, and superseded experiments. Development metrics are descriptive because cases were repeatedly inspected and used for iteration.

| Stage | Data | Main result | Decision |
| --- | ---: | --- | --- |
| Command A/A+ feasibility | Up to 500 unlabeled cases | Established provider/schema completion behavior and failure taxonomy | Retain as feasibility evidence only |
| Prompt screen | 100 development cases | Compared baseline, evidence-first, and coverage-checklist prompts using automated proxies | Prompt choice remains development-only |
| Held-out configuration run | 400 cases | JSON-schema reasoning-512: 350/400 technically valid; strict tools: 299/400 | Choose JSON schema; reject strict tools |
| Blinded automated judge | 396 judgeable pairs | Reasoning-512 had lower proxy burden than 128, but repeatability was weak | Proxy evidence only |
| Post hoc provenance gate | 400 cases | Only 40/400 passed; 5,467 generated quotations were not found lexically | Release blocker; redesign evidence contract |
| Evidence-span v2 | 20 development cases | 14/20 full gate passes; 202 evidence items | Conservative candidate |
| Multi-stage v3 | 5 development cases | 3/5 passes; recovery 5/5; median independent Jaccard 0.045 | Reject; retain negative result |
| V3 stability diagnostic | 2 cases | Whitespace mean label Jaccard 0.045 | Stop v3 scaling |
| Candidate-first v4 | 20 development cases | Pre-amendment 19/20 passes; 1 abstention; 39 calls; stable explicit-section core | High-recall candidate, semantic review required |
| V4 post-review amendment | 1 affected case plus deterministic rematerialization | Fixed `??????` bullet boundaries and removed interpretive labels | Full amended 20-case rerun pending |
| Blinded factual review | 30 sampled evidence units | Packet prepared locally; no completed labels | Pending |

## Important methodological lessons

1. Schema validity is not source fidelity.
2. Generated quotations are not reliable provenance evidence.
3. More model stages can increase cost without increasing stability.
4. Temperature 0 and a fixed seed do not guarantee identical model selection.
5. Deterministic source candidates create a stable core, but can over-extract when section parsing is too broad.
6. Plausible medical interpretation must be separated from direct source support.
7. Negative experiments should remain visible because they explain the final architecture.

Detailed reports are summarized by the root `README.md` and the archived `PROJECT_STATUS.md` snapshot.
