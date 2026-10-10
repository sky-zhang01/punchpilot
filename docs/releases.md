# Public releases

PunchPilot on GitHub is a derived publication. The independently installed publisher is the sole writer of public `main`, the public version tag and the GitHub Release. It does not reuse source-forge commit ancestry. The detailed operator commands and input boundaries are in [Public Promotion Boundary](branching.md#public-promotion-boundary).

Each public release commit carries the tree produced by `scripts/ci/export-public-tree.mjs` (`exportedTree`), bound to a provenance record that includes `sourceCommit`, `exportedTree`, `policyHash`, and `pathsetSha256`. Paths not selected by the source repository's pre-export allowlist policy are absent from the published tree.

## Production admission

The source signed annotated tag must already target reviewed source main S and pass its exact source release check before an artifact is produced. A legitimate OpenPGP signer, pinned public fingerprint, revoked-key set and unused version are required; historical tags are not moved. Producer and independent installer each verify live source refs, latest terminal CI, tag-object attestation and the S→E projection.

Only E's closed trees and blobs travel in the export pack. The source signed envelope and CI proof remain detached data; the consumer receives no source ancestry, source credential, internal remote or source checkout. Reviewed installed code, signing material, artifact digests and a source-CI snapshot are pinned outside the repository.

External typed owner/platform/runner admission binds the exact candidate and reviewed publisher entry, with an independently pinned SHA-256 and validity windows. Before each write, the publisher checks live platform protection. The named release bot must be the sole approved Git writer; the `public-release` environment must require the human owner and prevent self-review. The enable variable and receipt names alone are insufficient. Actual GitHub publication, platform settings and GHCR writes require the user's explicit confirmation; implementation and local rehearsal do not establish live readiness.

The actual B→E workflow subtree delta selects the repository-limited App token profile before its private key is read: `contents: write` alone, or exactly `contents: write` plus `workflows: write` under matching external admission. An excessive returned write permission is revoked and rejected.

## Tags and images

- The public promotion commit P has exactly one parent, the frozen public base B, and exactly tree E.
- P and its public annotated `vX.Y.Z` tag are unsigned, use the fixed release bot identity, and use S's committer timestamp in UTC. They have stable bytes and object IDs across retries; the source tag carries the OpenPGP signature.
- Public main and the tag are written in one non-force atomic transaction with exactly two explicit refspecs. There is no third approval ref.
- The installed publisher creates the GitHub Release only after fresh main/tag readback and the latest exact-P public CI has completed successfully. It validates terminal Release and Git readback rather than treating submission as completion.
- Container images published from GitHub use the same version.
- The Docker workflow is a GHCR writer only. Read-only jobs build and scan; privileged jobs consume those image/SBOM artifacts from the same run and attempt, using exact public P solely for reviewed tools. They recheck live admission, public refs, CI and the owner's approval of the actual protected workflow run before writes.

## Recovery

Retain the private publication state and its actual P/tag bytes and Git bundle. Node holds an OS file lock while it uses that state; the stable lock inode is not unlinked or replaced. A fresh process imports the saved objects and independently reads remote main/tag/Release state before resuming. Token renewal and a changed wall clock do not create new publication objects.

The same `state.json` retains candidate-bound observation attempts, including the installed entry/admission digests, actual platform response digests, public CI run/attempt, main/tag readbacks, terminal Release fields and freshly fetched Git object digests. Restore and the installed consumer preflight validate that record; `VERIFIED` requires the complete final platform, CI, Release and Git observations. Resuming begins a new attempt and checks live authority again. API credentials and full responses are excluded. The local observation checksum detects corruption; it is not an external signature or proof that another process cannot access the state.

Before submitting the Release, the publisher persists `RELEASE_REQUESTED`. If the response is lost or the process exits, recovery reads the exact Release until its terminal fields can be verified; it does not submit another POST while the result remains unknown. A confirmed rejection can permit the same frozen candidate to retry after admission is checked again.

A changed B, conflicting tag, altered artifact/policy or expired/revoked admission stops publication. Fresh admission may retain the saved objects only when the candidate tuple remains identical. If public CI fails after the atomic push, public main/tag can exist without a Release or image; use a forward fix with a new reviewed source commit and version, without moving the immutable tag.

Local `publication-boundary-dryrun.mjs --snapshot ... --state ...` uses the installed publisher against a local bare fixture and mock API evidence; it refuses a public HTTPS destination. It verifies the mechanism without granting production authority. The consumer's installed source-CI snapshot also leaves a residual window for source-side changes after installation; source governance and immutable tags constrain this window.

## Verification

Before treating a release as complete, confirm exact public P/tag object IDs, tree E, latest exact-P successful public CI, terminal GitHub Release fields and the GHCR multi-architecture digest/readback. The public tag, Release, package metadata and image tags must agree on `vX.Y.Z`. Local test success is not evidence of those live production results.

For ongoing public content and platform configuration observations, use the independent read-only [public governance check](public-governance.md). Its pinned baseline refers to the last reviewed published candidate, not advancing source main, and its evidence never grants publication admission.
