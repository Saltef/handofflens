# Security and Data Handling

## Never commit

- API keys, `.env`, credentials, authorization headers, or provider responses containing secrets
- the raw discharge-summary dataset
- private development, confirmatory, or reviewer cohorts
- case-level model outputs or source-containing review packets
- private method keys that unblind model identity

## Safe to commit

- source code and prompts
- JSON schemas and blank review templates
- explicitly synthetic fixtures
- aggregate metrics and reports without source quotations
- protocols, claims boundaries, and negative results

## Required check

Run before every push:

```bash
npm run check:share
```

The script fails when nonignored Git candidates contain likely secrets, private-data filenames, de-identification markers, or unexpectedly large files.

## Incident response

If a secret or source record is staged or committed:

1. stop before pushing;
2. remove it from the index and working tree as appropriate;
3. rotate any exposed credential;
4. rerun `npm run check:share`;
5. inspect Git history before sharing.

This repository does not provide a secure clinical-data runtime. Production use would require institutional access controls, audit logging, encryption, retention policies, and privacy review.
