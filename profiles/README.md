# HandoffLens Profiles

Profiles keep note-type and corpus-specific knowledge out of the extraction code. A profile defines section headings, cue regexes, normalization pairs, bounded lab-inference rules, and safety labels for one record family.

The default profile is `discharge-summary`. `clinical-dialogue` is intentionally small: it demonstrates portability for transcript-like records without claiming ACI-Bench performance.

## Contract

Each profile must include:

- `profile_id` and `schema_version`
- `domains`: domain keys with `headings` and `cues`
- `normalization_pairs`: explicit abbreviation expansions
- optional `lab_inferences`: measured heuristic rules, not clinical truth
- optional `safety_types`: labels used by downstream audit summaries

Run:

```bash
npm run profile:test
```

The CI check validates every profile JSON file and runs a smoke extraction under both shipped profiles.
