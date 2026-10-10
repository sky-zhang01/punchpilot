# PunchPilot Security Threat Model

## Scope

PunchPilot is a self-hosted attendance automation service for freee HR. The protected system includes the web UI, Express API, scheduler, SQLite database, encrypted settings, OAuth tokens, optional browser automation credentials, screenshots, logs, and Docker runtime data.

## Assets

- Application login credentials and active session cookies.
- freee OAuth client secret, access token, refresh token, company ID, employee ID, and user profile metadata.
- Optional freee Web login credentials used for explicit browser mode and Web-only fallback workflows.
- Attendance actions, daily schedules, execution logs, screenshots, and correction request data.
- The local encryption key stored outside the bind-mounted data directory.

## Trust Boundaries

- Browser to Express API: authenticated with an httpOnly session cookie.
- Express API to SQLite: trusted local process boundary; data is still encrypted for stored secrets.
- Express API to freee API: OAuth bearer token boundary.
- Browser automation to freee Web: higher-risk credential boundary; used in explicit browser mode and when API-based workflows cannot complete a required operation.
- Docker host to container: persistent data, logs, screenshots, and keystore are separate mounts.
- CI and release workflows: source mode verifies live source refs, exact CI and signed source tags; isolated consumption uses independently installed E-only inputs. Source execution evidence remains advisory against runner compromise. Public artifacts are independently rebuilt and scanned on GitHub-hosted runners.

## Main Abuse Paths

- Stolen session cookie or default account left unchanged.
- Brute-force login attempts against the local web UI.
- OAuth refresh token expiry or revocation causing silent missed scheduled attendance actions.
- Token or password disclosure through logs, screenshots, release notes, or CI output.
- Browser automation fallback using stale credentials and repeatedly failing without clear user action.
- Cross-architecture Docker drift between local development and deployment.
- Public releases accidentally including local paths, internal hosts, or secret-like values.

## Controls

- First login forces the initial administrator to change username and password.
- Fresh installations use a high-entropy one-time administrator password stored with mode `0600` in the keystore and removed after first password change; there is no shared default password.
- Sessions are random, stored as one-way token hashes, and sent through httpOnly cookies.
- Login attempts are rate limited per source IP.
- Stored credentials and OAuth tokens use AES-256-GCM with an installation-local key.
- The encryption key lives in the keystore mount, separate from the application data bind mount.
- OAuth token refresh failures are classified as either re-authorization-required or transient.
- Re-authorization-required failures pause the remaining scheduled actions for the day and surface status in the dashboard and logs.
- Transient OAuth refresh failures use bounded retries before pausing automatic actions.
- Security headers include CSP, frame denial, content sniffing protection, referrer policy, resource policy, permissions policy, and HTTPS-only HSTS. Secure cookies and HSTS use the validated canonical public origin when configured instead of trusting forwarded-protocol headers.
- Release workflows scan the outgoing tree, every new commit blob, commit messages, and tag metadata for secret-like values, private IPs, local home paths, and configured forbidden hostnames. The scanned outgoing object is the exporter's `exportedTree` (tree E).
- Privacy-gate findings use hashed locations and fixed labels so blocked content is not repeated into CI logs.
- Screenshot capture and retention cleanup require a private, process-owned directory with a PunchPilot ownership marker; unrecognized shared-directory content and symbolic links observed during validation are rejected without deletion.
- Source and public workflows use separate forge-specific directories. This reduces routine cross-forge event exposure but is not an authorization boundary against write or admin actors.
- Before export, the source repository's allowlist policy gate and coverage tests enforce default-deny path filtering so no unlisted internal path reaches the public release tree.
- Source production and independent installation each verify live source main, the pre-existing signed annotated version tag, exact latest successful CI jobs and tag-object attestation, then recompute the allowlisted S→E projection. The source signer fingerprint, revoked-key set, artifact digests, reviewed code and source-CI snapshot are pinned in protected external files. Privacy warnings fail the canonical publication gates.
- The isolated publisher imports only E's closed tree/blob pack and public B/P ancestry. Initial E import rejects commit/tag objects, extra objects, refs, remotes and alternates; resume bundles allow only the two prepared publication refs. The raw signed source-tag envelope is verified outside the Git object database. The consumer rejects source objects and internal inputs and executes installed reviewed gates rather than programs from E; the approved runtime has no source checkout, source credential or internal network access.
- Typed external owner/platform/runner receipts bind the candidate and reviewed entry, with validity windows and an independent admission SHA-256. The source-CI snapshot is distinct from this approval. Every public write requires fresh live platform protection; an enable flag, environment name or free-form pass claim is insufficient.
- The actual B→E workflow subtree difference selects the App token's exact contents-only or contents-plus-workflows write profile before private-key access. The repository-limited token response is checked and excessive write permissions are revoked.
- Public main/tag use a single non-force atomic two-ref transaction. Unsigned P and the public annotated tag use a fixed bot identity and S's committer timestamp, with P rooted only on public B and tree E. Their actual bytes and bundle are fsynced before writing, and Node retains the descriptor holding an OS file lock across writes and recovery.
- The publisher is the sole GitHub Git/Release writer and requires the latest terminal successful exact-P public CI before creating a Release. The Docker workflow writes only GHCR artifacts/attestations. Its protected environment requires the human owner with self-review disabled; privileged jobs use exact public P for reviewed tools and consume scanned images from the same run/attempt. They do not build or install application dependencies or receive internal checkouts, and they recheck refs, latest CI, live protection and approval of the actual workflow run before writes.
- The container validates non-zero `PUID`/`PGID` values, limits root to mounted-volume ownership setup, and executes the application through `gosu` as the configured user.
- The standard Compose deployment drops all default capabilities, adds back only those needed for ownership setup and Chromium namespace creation, applies `no-new-privileges`, and enables Chromium's internal sandbox through a pinned Playwright seccomp profile.
- Container scanning blocks every High or Critical finding that has a vendor fix; the scan filters vendor-unfixed findings with `--ignore-unfixed`, so a finding re-enters the blocking set automatically as soon as its distribution publishes a patch.
- CI runs security lint, dependency audit, unit coverage, client build, E2E smoke, security scanning, amd64 pull-request builds, and multi-architecture release-candidate builds.

## Residual Risk

- Browser automation remains heavier and more failure-prone than API calls, but it is the primary path for users without API access and remains necessary for Web-only workflows. It is deterministic and serialized, with bounded queue and operation timeouts.
- Screenshots can contain sensitive attendance page content. They are disabled by default; opt-in files require authentication and are automatically cleaned up only from the claimed private screenshot root.
- The screenshot root and its parent remain operator trust boundaries. Do not share them with another process running under the same UID, which could race path-based cleanup after validation.
- Operators must configure HTTPS at the reverse proxy if exposing the service beyond a trusted local network.
- OAuth authorization can still expire or be revoked externally; the system can detect and pause, but the user must re-authorize.
- The container entrypoint starts as root to repair mounted-volume ownership. CI verifies the application command runs as non-root; the scanner exception for the missing Dockerfile `USER` instruction is narrow and time-limited.
- The browser-capable base image may temporarily retain vendor-unfixed operating-system findings; they are not individually actionable while no patch exists and automatically re-block the next build once the vendor publishes a fix.
- Image-only platforms do not enable Chromium's internal sandbox automatically because the required seccomp profile is a host-runtime policy. Operators should apply the bundled profile before enabling it and must not replace it with an unconfined profile or broad `SYS_ADMIN` capability.
- A compromised source runner can falsify source CI and release-check evidence. Exact candidate review, the external publication snapshot, the local privacy gate, and the independent public rebuild remain the publication controls.
- The isolated consumer holds an installer-time source-authority snapshot, not live source API access. Source-side changes after installation remain a trust window constrained by source governance and immutable tags; changed local bindings or expired/revoked admission stop writes.
- An atomic public push can finish before public CI fails. Main and the immutable tag may then exist without a Release or image; recovery requires a new reviewed source commit/version rather than moving the tag. Lost-response recovery imports the exact saved objects and checks remote terminal state.
- Bypassing the installed hook, compromising the maintainer machine or public-owner account, or approving malicious behavior during exact-head review remains outside what repository automation can prevent.

## Release Gate

Before release, require dependency audit, security lint, unit coverage, client build, E2E smoke, privacy and multi-architecture build/scanning results bound to the exact candidate. Install source/consumer modes as documented in [branching.md](branching.md#public-promotion-boundary); the source hook refuses public writes and the isolated publisher's hook calls trusted installed consumer gates. Legitimate signer and live owner/platform/runner admission remain production prerequisites. Actual GitHub Git/Release/settings/GHCR writes require explicit user confirmation; local mechanism tests do not satisfy those live checks. Changelog and release notes must describe product changes only and must not include internal development process, local paths, internal hosts, tokens, or private tracker references.
