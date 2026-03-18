# PunchPilot Version Support Matrix

Updated: 2026-03-18

## Why This Exists

Recent maintenance exposed that PunchPilot had three different version baselines in practice:

- local developer shells were not guaranteed to use the same Node toolchain
- GitHub Actions CI validated only `Node 22`
- the Docker image was built on `node:25-slim`

That is not enough for safe upgrade work. Version validation should explicitly cover:

1. minimum supported
2. current pinned / production
3. latest upstream

## Support Bands

### Minimum supported

- Node: `20.19.0`
- Reason: current `vite` dependency requires `^20.19.0 || >=22.12.0`

### Current pinned / production baseline

- Node: `22.22.0`
- Reason: this is the intended default developer baseline for the repo now (`.nvmrc`) and the most conservative stable lane for general operation

### Latest upstream lane

- Node: `25`
- Reason: current Dockerfile already builds on `node:25-slim`, so we must keep a validation lane for the newest runtime we actively ship

## Current Repo Policy

- `package.json` now declares:
  - `>=20.19.0 <21 || >=22.12.0 <26`
- `.nvmrc` points to `22.22.0`
- CI runs `lint` and `test` on:
  - `20.19.0`
  - `22.22.0`
  - `25`

## Operational Reading

- If `20.19.0` fails, we broke the minimum support floor.
- If `22.22.0` fails, we broke the default supported baseline.
- If `25` fails, latest upstream is currently `known unsupported` and should be treated as such until fixed.

## Local Environment Caveat Found During This Audit

On the maintainer machine used for this review, the active Node toolchain was inconsistent:

- one shell path resolved to a broken Homebrew `node@22`
- that binary failed to load a missing `simdjson` dynamic library

This is a workstation toolchain issue, not a PunchPilot repo bug. It can still make `npm test` or `git pull && build` look broken locally even when the repo itself is healthy.

## Next Good Cleanup

1. Decide whether the Dockerfile should stay on `node:25-slim` or be pinned back to `22` for stricter alignment.
2. If Docker remains on `25`, keep the latest lane in CI permanently.
3. Record `known unsupported` explicitly whenever the latest lane breaks, instead of silently assuming support.
