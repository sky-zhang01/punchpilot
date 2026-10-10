# Security Lint Baseline

`npm run lint:security` (CI `Lint` job, and `tests/security-lint-gate.test.mjs` in the
`Test` job) runs `scripts/ci/security-lint-gate.mjs`, which compares the repository's
current security-lint state against the committed `security-lint-baseline.json`
snapshot. The baseline binds:

- the installed `eslint` and `eslint-plugin-security` versions as provenance,
- the SHA-256 of `eslint.config.mjs`,
- every low-confidence warning, each pinned to the file hash, line hash, rule,
  column, and occurrence.

Configuration or finding drift — a new, removed, or moved warning — fails CI.
A toolchain version change alone is non-blocking; changes to its findings still
require review. The gate deliberately never updates the baseline itself.

## When to rebaseline

Only in the same pull request as the change that causes the drift, never after
the fact and never on its own:

- `eslint` or `eslint-plugin-security` is upgraded (typical renovate dependency PR),
- `eslint.config.mjs` is intentionally changed,
- reviewed `server/` source edits add, remove, or move low-confidence findings.

If the gate fails and none of those applies, the drift is unexplained: treat it
as a finding, not as a baseline refresh.

## Who rebaselines

The author of the pull request that introduces the toolchain, configuration, or
source change. Reviewers own the approval: the baseline diff is part of the PR
and CI keeps failing on any mismatch, so a rebaseline can never land silently.

## How to rebaseline

Install the new toolchain first (the baseline records the *installed* versions),
then regenerate:

```bash
npm ci --ignore-scripts
npm run lint:security:rebaseline
```

`npm run lint:security:rebaseline` (`security-lint-gate.mjs --update`) rewrites
`security-lint-baseline.json` in canonical form (fixed field order, canonically
sorted warnings, recomputed `config_sha256`) and prints every accepted change.
Never hand-edit the JSON — the parser rejects non-canonical files, and
regenerating is both easier and auditable.

## Review criteria for a baseline diff

- `eslint_version` / `plugin_security_version` move exactly with the dependency
  change in the same PR.
- `config_sha256` changes only when `eslint.config.mjs` changed in the same PR.
- Every new or stale warning traces to a reviewed `server/` source change; the
  command output lists each one with file and line hashes.
- Nothing else moves. A diff that mixes unrelated findings with a toolchain bump
  is two changes and should be split.
