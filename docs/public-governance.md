# Read-only public governance

The source-only `Public Governance Check` workflow checks the last independently reviewed **published** candidate every Monday at 03:17 UTC and on manual dispatch. It does not compare GitHub with the latest source main: unreleased source changes are expected. The existing PR drift comment checks exported path membership between source commits; this independent check compares the whole public tree and publication objects, plus settings outside Git.

Neither an observation, its SHA-256, a successful job nor this workflow grants owner approval, runner isolation admission or publication authority. The installed publisher continues to enforce the existing publication contract. GitHub settings/ref/tag/Release/GHCR writes and credential rotation require the owner's separate confirmation.

## Reviewed input and actual consumer

The private `punchpilot-public-governance-baseline` JSON stays outside the checkout. Its SHA-256 must be pinned independently after reviewing the published candidate and configuration; the collector cannot create a baseline. Do not accept the collector's current observations as a baseline without independently reviewing the differences. During initial cutover, a canonical publication does not yet exist, so `observe` must report UNKNOWN rather than inventing a successful release.

The input contains:

- `repository: "sky-zhang01/punchpilot"`, the fixed destination from the publication contract.
- `publication`: `sourceCommit` S, `exportedTree` E, `publicBase` B, `version`, `sourceEpoch`, and `policyHash`, copied from the final reviewed publication artifact and verified publication state. `canonicalObjects` recomputes P and the public annotated tag from that same tuple; no separate P parameter can disagree.
- `appId` and `installationId`, from independently verified release App metadata, not a guessed bot name.
- `configuration`: reviewed repository identity/security settings, full ruleset details, environment/protection rules and every deployment branch policy, Actions permissions/selected actions/default token permissions, every deploy key and collaborator, App metadata and installation metadata. It uses the REST field names consumed in `validateBaseline`; runtime validation rejects missing protection fields. Volatile API timestamps, counters, avatar URLs and links are excluded from configuration comparison.

The source checkout must contain S. The checker reads the allowlist **at S**, recomputes S→E with the existing exporter and privacy gate, verifies `policyHash`, inspects CODEOWNERS and full-SHA public workflow action pins, and compares actual GitHub main/tag/tree/parent with canonical P/tag/E/B. The source code executing the check has its own `codeCommit` and workflow run/attempt binding; it may be newer than the last published S.

These source checks accept the project's reviewed syntax rather than implement a general YAML or CODEOWNERS parser. CODEOWNERS must have exactly one active `* @sky-zhang01` rule; any additional rule, including an ownerless override, is rejected. Workflow `uses` entries must use plain block mapping keys and exact full SHA values. Script block scalars, single-line scalar strings, GitHub expressions and simple scalar lists remain data; flow mappings, mapping pairs inside flow lists, quoted keys, explicit keys, anchors, aliases, tags and other unverified forms are rejected. A workflow syntax change needs review before widening this shape gate. The normal workflow syntax/lint gate remains independent.

Only GET requests to fixed GitHub API endpoints are possible. Paginated collections follow same-origin sequential Link pages, require counts where supplied, reject duplicate/missing identities, and refuse truncated or unprovable completion. Ruleset details are fetched for **every** returned ruleset, including applicable parents. Missing `bypass_actors` visibility cannot prove a sole writer. HTTP 403/404, unavailable fields, timeout, malformed JSON and failed pagination remain UNKNOWN or a failed check, never an empty successful collection. Main and the version tag are sampled again after collection to detect movement during the observation.

Both collection and evidence consumption fully parse the supported Link shape: quoted or unquoted `rel`, parameters before `rel`, multiple registered relation tokens and comma-separated links. They follow a single `next` relation regardless of a short first page. Duplicate parameters, changed link context (`anchor`), escaped quoted values, extension relation URIs, malformed or unconsumed syntax and ambiguous next destinations are rejected rather than treated as completion. This deliberately bounded grammar follows the relation semantics in [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288.html#section-3.3); it does not claim to accept every RFC header form. The strict CODEOWNERS policy avoids the later-match and ownerless-override semantics documented by [GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).

`check` saves canonical private observations, source result, report, hashes and safe summary, then `verifyEvidence` actually rereads them and recalculates the decisions. The workflow invokes the separate `verify` consumer before retaining only `summary.json`. That summary contains run/candidate identifiers, check results and digests; it contains no private baseline, response bodies, reviewers, collaborator list, keys or credential values. Private response files remain mode 0600 in a mode 0700 directory and are removed from the runner at the end. Operators who need durable raw evidence must retain it in their protected evidence store before runner cleanup; the public-safe summary alone cannot reproduce API contents or replace independent live readback.

## Installation and permissions

Provision the following source-forge inputs through the existing protected configuration process:

- `PUNCHPILOT_PUBLIC_GOVERNANCE_BASELINE`: exact canonical JSON bytes, including the trailing newline.
- `PUNCHPILOT_PUBLIC_GOVERNANCE_BASELINE_SHA256`: independently reviewed digest, configured separately from the secret baseline.
- `PUNCHPILOT_PUBLIC_GOVERNANCE_READ_TOKEN`: dedicated observer access. Contents/metadata read covers public refs; repository Administration read is needed for Actions policy, collaborators and deploy-key enumeration. Do not give this workflow the release App private key, source signing key, publication token or write credentials to resolve missing visibility.
- `PUBLIC_RELEASE_FORBIDDEN_HOSTS`: the existing private privacy policy. Its values are never logged or included in the safe summary.

GitHub currently documents `/user/installations` for GitHub App **user access tokens**, while `/repos/{owner}/{repo}/installation` requires an App JWT. An ordinary observer PAT cannot supply this installation authority. The checker does not mint a token or search for another credential. Thus ordinary read-only observers can verify visible content/settings individually, but installation may remain UNKNOWN and the overall report must not claim complete platform PASS. Even visible installation metadata describes configured App grants, not the permissions of a publication token; the publisher independently checks each minted token's returned scope before a write.

Environment REST readbacks on 2026-10-08 returned `can_admins_bypass: false`. The collector requires this explicit value; if a response lacks a verifiable administrator-bypass field, `administratorBypass` stays UNKNOWN and the complete configuration cannot pass. Do not add a fabricated `false` to a snapshot or treat a successful GET as proof that every required protection field is visible.

Feasible choices for the missing ongoing installation observation are an independently operated periodic GET readback through the owner's admitted App identity, or an expressly reviewed GitHub App user-token observer route. Both require an explicit review of secret exposure and actual supported permissions. A one-time installation readback is evidence for that preparation run, not perpetual weekly verification. Keep UNKNOWN until the chosen route is established; do not add a service or credentials merely to make the job green.

Local observation before there is a reviewed baseline:

```sh
node scripts/ci/public-governance-check.mjs observe \
  --version vX.Y.Z --run-id observation-id --run-attempt 1 \
  --evidence "$private_evidence_dir"
```

The version must be a real `vX.Y.Z` argument. Supply `PUNCHPILOT_PUBLIC_GOVERNANCE_TOKEN` through the calling process's approved credential binding, never a CLI argument. This mode writes observations but intentionally returns nonzero UNKNOWN. It grants no publication readiness.

Once the baseline is independently reviewed:

```sh
node scripts/ci/public-governance-check.mjs check \
  --baseline "$reviewed_baseline" --baseline-sha256 "$reviewed_baseline_sha256" \
  --run-id observation-id --run-attempt 1 --evidence "$private_evidence_dir"
node scripts/ci/public-governance-check.mjs verify \
  --baseline "$reviewed_baseline" --baseline-sha256 "$reviewed_baseline_sha256" \
  --evidence "$private_evidence_dir"
```

PASS means the observed content/configuration matched this pinned baseline at that observation. It is not an authorization, proof of every external writer's secrets, a full public-history scan, GHCR acceptance or runtime isolation proof. FAIL means observed drift; UNKNOWN means the required evidence was unavailable. Both return nonzero. Historical privacy remains the publisher's full-ancestry gate and independent history classification task; this check does not weaken, suppress or substitute that gate.

## Credential rotation

This is an operator procedure, not an automated rotation command. Retain the published object IDs, bundle and proof before any change. Never move immutable public tags to recover a credential problem.

1. Identify the affected credential and reason without copying secret bytes into logs. Freeze new publication admission. Stop the actual publication/GHCR jobs through their admitted owner controls and confirm they have stopped; ordinary read-only governance collection can continue if its observer is unaffected. Record the prior App/installation IDs, signer fingerprints, policy/baseline digests and candidate tuple.
2. For a suspected leak, revoke or suspend the affected credential through the owner's platform identity first. For planned App-key rotation, create the replacement through owner controls, install it only in the independently admitted publisher secret store, validate App/installation metadata by GET and scope selection through the existing isolated minting path, then remove the superseded key. Do not install either private key in the source weekly collector. Observe actual revocation/denial, not only a submitted mutation response.
3. For a source OpenPGP key change, have the authorized signer create and custody the replacement. Independently verify its full public fingerprint, update the revoked-key set and admitted signing material, and use a new reviewed S/version for the next source tag. Reinstall the independently reviewed hook/consumer snapshot as required. Existing release verification must use its historical trust bindings rather than silently accepting another key.
4. For an observer credential, replace only the source workflow's observer binding and validate the same GET endpoints and needed visibility. Do not reuse a publication credential to improve coverage. Remove/revoke the superseded observer, and verify its rejection without logging token bytes.
5. Review all changed platform and runner trust bindings. Update external admission and governance baseline/pinned digest through their independent owners; a changed digest is not approval. Re-run read-only collection and separate isolation/source-signature gates. Retain all UNKNOWN results and any changed grants. Resume public writes only after the owner confirms the actual reviewed publication and every existing admission gate succeeds.

The rotation record should contain the operator identity, reason, old/new **public** identifiers, actual terminal readbacks, revoked identifiers, candidate/ref bindings and evidence digests. It must not contain private keys or access tokens. Rotation is complete only after superseded access is denied, replacement access is verified and affected publication recovery state remains bound to the same permitted candidate or is replaced by a newly reviewed candidate.

## API references

The collector uses GitHub's [repository rulesets](https://docs.github.com/en/rest/repos/rules), [Actions permissions](https://docs.github.com/en/rest/actions/permissions), [environments](https://docs.github.com/en/rest/deployments/environments), [deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies), [GitHub Apps](https://docs.github.com/en/rest/apps/apps) and [installation metadata](https://docs.github.com/en/rest/apps/installations) endpoints. Endpoint names and permissions were checked against official documentation on 2026-10-06. Configuration snapshots are observations, not signed platform assertions or owner approval receipts.
