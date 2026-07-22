# Pre-publish Safety Checklist

## Secrets

- `.env` is ignored by Git.
- `.env.example` contains blank placeholders only.
- No OpenRouter, Cohere, Anthropic, or other API keys should be committed.

Run this before publishing:

```bash
rg -n --hidden --glob '!clinical_cases.csv.gz' --glob '!.git/**' --glob '!.env' --glob '!eval/dataset_sample_*.json' --glob '!results/**' "sk-or-v1|OPENROUTER_API_KEY=\S+|COHERE_API_KEY=\S+|ANTHROPIC_API_KEY=\S+|api[_-]?key|secret|token|Bearer\s+[A-Za-z0-9]" .
```

Expected hits should be placeholders, documentation, or validator code only.

## Dataset

- `clinical_cases.csv.gz` is ignored by Git.
- Do not commit the full dataset.
- Keep only small demonstration/evaluation cases in `eval/pilot_reference_cases.json`.
- Generated `eval/dataset_sample_*.json` and `results/` artifacts are ignored by Git.

## Docker

- `.dockerignore` excludes `.env`, raw dataset files, generated samples, and results.
- Docker demo target serves only static files.
- Docker eval target copies the full public repository artifact set and runs `npm run check:all` at build time.
- Docker benchmark paths mount externally downloaded corpora from ignored `benchmark_data/`; benchmark corpora are not baked into the image.
- Docker eval target can run local validation and scripts but should receive API keys only through explicit runtime environment variables, not baked image files.

## Local Validation

Run:

```bash
npm run check
```

This validates required files, prompt/schema structure, pilot reference category coverage, Moore et al. handover rubric presence, and secret hygiene.
