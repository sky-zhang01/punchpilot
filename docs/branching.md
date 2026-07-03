# Branching and Version Housekeeping

PunchPilot uses `main` as the only long-lived integration branch. Release state is carried by annotated `vX.Y.Z` tags, matching package metadata, changelog entries, Docker labels, and published container images.

## Branch Model

- `main` is protected and must stay deployable.
- Feature, fix, CI, and Codex branches are short-lived and should be deleted after merge.
- Bot branches from Dependabot or Renovate remain only while their PR is open or under active review.
- Release branches such as `codex/release-vX.Y.Z` are temporary. After the release commit, annotated tag, GitHub Release, Gitea readback, and package/image readback are complete, delete the branch from every remote.
- Do not delete an unmerged branch just because it is old. Close or supersede the PR first, then delete the branch with evidence.

## Version Rules

- Keep `package.json`, `package-lock.json`, `client/package.json`, `client/package-lock.json`, `Dockerfile` OCI version label, and `CHANGELOG.md` on the same version.
- Public releases require an annotated `vX.Y.Z` tag and the internal handoff marker checked by `scripts/ci/release-metadata-check.mjs`.
- GitHub `origin`, Gitea `gitea`, release tags, GitHub Release metadata, and container image tags must agree before a release is considered complete.
- Maintenance-only branch cleanup and policy changes do not bump the app version.

## Routine Cleanup

Preview cleanup candidates:

```bash
npm run housekeeping:branches -- --fetch --remote origin --remote gitea --include-local
```

Delete only candidates whose tip is already contained in the configured `main` base:

```bash
npm run housekeeping:branches -- --fetch --remote origin --remote gitea --include-local --delete-remote --delete-local --confirm-delete-merged-branches
```

For local storage cleanup, also prune stale worktree metadata after removing obsolete worktrees:

```bash
git worktree prune
git fetch --all --prune --tags
```

The scheduled CI job runs a dry-run only. Remote deletion stays an explicit maintainer action because GitHub and Gitea have separate authority surfaces and credentials.
