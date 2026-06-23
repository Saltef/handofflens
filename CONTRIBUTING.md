# Contributing and release checklist

This repository is maintained as a public-facing portfolio/research artifact. Keep the public surface readable for engineers and data scientists, and keep private clinical data out of Git.

## Local validation

Before committing or sharing, run:

```bash
npm run check:all
```

This runs syntax checks, protocol/repository validations, deterministic unit tests, and the share-readiness scan.

For a faster privacy check:

```bash
npm run check:share
```

Expected result: no private datasets, generated case-level outputs, API keys, or review packets are visible to Git.

## Public exports

To create the complete clean public export:

```bash
npm run export:clean
```

Default output:

```text
../handofflens-clean-release
```

To create the recruiter-facing curated export:

```bash
npm run export:portfolio
```

Default output:

```text
../handofflens-portfolio-release
```

The portfolio export keeps runnable code and canonical validation docs, while excluding noisy exploratory/provider-specific reports from the public surface. The conformal/selective-routing work is still represented by `docs/conformal-routing-ongoing.md`.

## Do not commit

Do not commit:

- `.env`
- API keys or bearer tokens
- `clinical_cases*`
- private eval cohorts
- private reviewer packets
- generated case-level outputs under `results/` or `outputs/`
- model-key files
- raw or derived source-record text that is not explicitly synthetic

The `.gitignore`, `.dockerignore`, and `scripts/check-share-readiness.js` scanner enforce this boundary.

## Public language rules

Use public-facing language. Assume the audience is an engineer, data scientist, recruiter, or hiring manager.

Allowed framing:

- source-grounded extraction;
- deterministic provenance checks;
- schema validity versus evidence fidelity;
- abstention and review readiness;
- engineering validation and proxy-risk routing;
- ongoing work where labels or review are pending.

Avoid claiming:

- clinical validation;
- clinical safety;
- clinical correctness;
- harmful-error reduction;
- autonomous use;
- generalization to external hospitals or patients;
- superiority of one provider model as a clinical conclusion.

## Conformal/selective-routing appendix

The conformal scripts remain in `scripts/` because they are ongoing work relevant to engineers and data scientists. Frame them as proxy-risk routing experiments, not as clinical safety control.

Canonical public explanation:

> The conformal work is a selective-routing appendix. The main result is source-fidelity measurement and candidate-first extraction. Once failures are observable, the next engineering question is how to route cases based on proxy risk signals. The conformal scripts test that idea with proxy labels, but those labels are not clinical truth.

## Release checklist

1. Run `npm run check:all`.
2. Confirm `git status --short` has only intended changes.
3. Regenerate the intended export:
   - `npm run export:portfolio` for a recruiter-facing repo.
   - `npm run export:clean` for the full clean artifact.
4. In the exported folder, run `npm run check:share`.
5. Push the exported folder, not the local working repo with private ignored files.

