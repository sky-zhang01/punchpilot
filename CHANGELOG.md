# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-10-10

### Fixed
- Restored automatic skipping for approved full-day leave returned through freee's current `paid_holidays` work-record schema, including numeric special leave and combined leave entries.
- Re-checked approved leave immediately before each scheduled action through the Public API when available or the authenticated Web attendance view in Browser-only deployments.
- Made Web punches and forms fail closed unless login, company, attendance state, server-side punch writes, target dates, and form submission outcomes can be positively confirmed, including a final target-date record check immediately before leave submission.
- Prevented a stale Chromium disconnect event from invalidating a newer browser process.
- Rejected malformed approval request identifiers before starting batch withdrawal work.
- Limited approval withdrawal to the current user's own cancellable requests and stopped when request details could not be confirmed.
- Prevented duplicate leave and work-time correction submissions when a matching request for the same type and date is already pending.
- Stopped unclassified Public API client errors from triggering a Web write fallback.
- Kept dashboard status and attendance logs isolated to the initiating company, including manual actions that finish during an account change, and bounded log pagination inputs.
- Rechecked scheduler authorization at the final API dispatch boundary, including after state queries and token refresh, while keeping cancelled pre-dispatch actions eligible for the updated schedule.
- Paused Browser-mode schedules until the configured freee employee identity is verified, including existing installations upgraded to this release.
- Bounded browser cleanup and terminated the service if Chromium could not be stopped safely after an operation timeout.
- Paused automatic actions when freee work-record or time-clock fields do not match a supported response schema instead of treating malformed data as an empty working day.
- Matched existing special leave by its exact setting and full-day unit before treating a request as already completed.
- Bound approval and cancellation decisions and success to the expected request identity, company, actor, type, status, action log, and current authoritative read-back.
- Persisted each historical correction result before processing the next date so completed entries remain auditable after interruption.
- Used the configured Tokyo calendar date for attendance capability and correction-strategy probes around UTC day boundaries.
- Ran a just-past check-in immediately when startup analysis keeps it inside the existing five-minute grace window instead of discarding it as an ordinary past-due action.

### Security
- Stored one-way hashes instead of reusable session tokens and transparently migrated active legacy sessions.
- Equalized password-hash verification for known and unknown usernames to reduce login account-enumeration timing signals.
- Replaced the shared default administrator password with a high-entropy one-time keystore bootstrap that is removed after first password change.
- Disabled browser screenshots by default, protected opt-in screenshot access, and removed credential-page captures and raw page text from browser errors.
- Restricted screenshot retention cleanup to a private, explicitly claimed PunchPilot directory and refused unrecognized shared-directory content.
- Tightened AES-GCM input validation, authentication-tag handling, application-secret validation, and keystore permissions.
- Enforced private ownership and permissions for the SQLite database, WAL, SHM, and data directory, and rejected symbolic-link database paths.
- Moved OAuth popup behavior to a CSP-compatible external script.
- Anchored OAuth callbacks and state-changing request checks to a configured canonical public origin, required an application marker for cookie-authenticated writes without browser metadata, rejected insecure external origins, and marked authenticated screenshot responses as private and non-cacheable.
- Derived Secure session cookies and HSTS from the validated canonical HTTPS origin so TLS-terminating proxy deployments do not depend on untrusted forwarded-protocol headers.
- Sanitized browser, API, and release errors to use stable failure codes without exposing upstream page content or local paths.
- Validated configuration input types, rejected incomplete or duplicate OAuth company and employee identities, and retained only the minimum OAuth company metadata needed by the application.
- Blocked dependency lifecycle scripts during installation and verified the bundled `better-sqlite3` N-API addon without an install-time rebuild.
- Bound API-to-Web mutations to an immutable OAuth company and employee snapshot, validated intercepted punch, leave, correction, withdrawal, and monthly-closing requests against the intended action, request ID, date, year, month, and identity at dispatch, rechecked the selected company immediately before final writes, and rejected ambiguous or changed identities.
- Restricted the Chromium child process to browser runtime environment variables instead of inheriting application credentials and encryption secrets.
- Serialized OAuth token refreshes and rejected stale refresh writes or conflicting persisted company selections.
- Hardened public release integrity checks to bind artifacts to an exact reviewed commit and annotated tag, rebuild and scan images before publication, and reject stale vulnerability exceptions.
- Enabled Chromium namespace/seccomp sandboxing in the standard Compose deployment with a pinned Playwright profile, minimal startup capabilities, and `no-new-privileges`.
- Updated the pinned Chromium seccomp profile for current Node.js and `runc` process and procfs handling while retaining capability drops and `no-new-privileges`.
- Rejected zero or invalid container user IDs and verified the runtime privilege drop.
- Bound Browser-only automation to a verified freee employee identity instead of relying on company name alone.
- Derived stable, one-way log partitions from the installation key so reauthorization preserves the same account history without exposing account identifiers or mixing histories across accounts.
- Expanded public-release privacy checks across reachable commit history and metadata to cover quoted configuration and HTTP credentials, local home paths including value-terminating paths, private network data, forbidden hosts, and unclassified hexadecimal credentials from 32 characters without echoing blocked content.
- Made public promotion carry the exporter's filtered tree (`exportedTree`) and provenance record, while keeping source-only commit history outside the public lineage.
- Bound source CI authority checks to exact successful Gitea Actions runs and jobs when synthetic status-creator metadata is unavailable.
- Enforced a seven-day dependency release-age gate from immutable npm tarball metadata, with exact and time-bounded exceptions restricted to public security advisories.
- Updated the runtime SQLite library to `libsqlite3-0` 3.53.4-2 with architecture-specific checksum pins.
- Hardened unfixed Debian `perl-base` and `libxml2` exposure by removing unused Perl interpreter entrypoints, guarding every browser context, enforcing bounded Web-operation deadlines, and measuring disconnect recovery in the final image.
- Replaced the count-based security lint allowance with an exact tool-, configuration-, and whole-source-context-bound finding baseline that disallows source-level lint overrides and rejects new, removed, changed, or high-confidence findings.
- Updated the checksum-pinned Trivy scanner to 0.75.0, including go-getter 1.8.9's removal of special permission bits when extracting the vulnerability database and built-in checks archives.
- Separated public platform reads from publication writes, compared shared protection fields without volatile API metadata, and required administrator bypass to be explicitly disabled.
- Removed the expired npm release-age exception after its package passed the normal seven-day eligibility window.

### Changed
- Standardized local development, CI, and container builds on Node.js 24.21 LTS and npm 12.2, retaining the Node 24.15+ compatibility floor and install-time script restrictions.
- Updated the scheduler runtime to `node-cron` 4.6.0.
- Updated build tooling to Vite 8.3.2, TypeScript 7.0.2, and `es-module-lexer` 3.0.2; removed the direct Rolldown override so Vite owns its compatible bundler dependencies.
- Updated client dependencies to Redux Toolkit 2.13.0, i18next 26.4.2, react-i18next 17.0.15, React Router 8.4.0, React 19.3, and `@types/node` 24.19.0; replaced Axios with the shared native Fetch client.
- Updated test tooling to Vitest 5.0.3 and `@vitest/coverage-v8` 5.0.3, with test files running in parallel by default, and upgraded `eslint-plugin-security` to 4.2.0.
- Reused the checksum-verified Node installer across both forges, removed `actions/setup-node`, and pinned the reviewed security updates Buildx 0.37.2 and BuildKit 0.33.1 alongside QEMU 10.2.3 and Trivy 0.75.0; prepared public CI for Ubuntu 26.04 LTS on both architectures.
- Consolidated installation paths, calendar dates, schedule parameters, account identities, freee response contracts, and persisted task checkpoints into shared modules; removed unused Chalk and dotenv dependencies.
- Reused the Chromium process and in-memory Web session across nearby serialized operations, removed artificial slow motion from the core punch flow, and added bounded queue and operation deadlines.
- Replaced fixed post-submit browser delays with bounded state-based waits for correction, leave, withdrawal, and monthly closing forms.
- Added coordinated graceful shutdown that stops new work and drains in-flight scheduler, browser, batch, account, and HTTP operations before the container exits.
- Removed non-atomic sequential time-clock writes from historical batch correction; corrections now use direct updates, approval requests, or verified Web forms.
- Installed only Chromium Headless Shell for headless automation to reduce image and CI download weight.
- Split server/browser dependencies from the client build so unchanged Chromium and native dependency layers are reused across ordinary source and UI image builds.
- Refreshed final runtime OS packages on every container CI and release build while retaining dependency and Chromium build caches.
- Validated release candidates with privacy, dependency, test, E2E, security, and amd64/arm64 container checks, using target-architecture BuildKit evidence for emulated source builds and native arm64 browser verification before public publishing.
- Scoped routine pull-request Docker validation to Linux amd64 while keeping published images multi-architecture.
- Required every Docker Node base stage to match the reviewed local and CI runtime version so automated image updates cannot silently downgrade the application runtime.
- Configured routine dependency updates with a seven-day release-age buffer while keeping vulnerability alerts and security updates immediate and isolated.
- Split version-update grouping by runtime, build, test, and lint toolchains so unrelated release-age checks do not hold back eligible updates.
- Aligned source-tag validation with the separate public promotion lineage while retaining full history scans for public updates.

## [0.4.14] - 2026-07-01

### Fixed
- Monthly attendance closing now treats an already-submitted request as a successful idempotent result.
- Monthly attendance closing now reports clear web credential errors when browser fallback is required but unavailable.

### Changed
- Updated compatible server and client dependency patch releases.
- Updated React Router to 8.1 for the client application.
- Added an internal release-check workflow that validates release metadata, privacy scanning, dependency audits, tests, E2E smoke, and the Linux amd64 Docker build before public publishing.
- Limited the public Docker publish workflow to GitHub-hosted release publishing.
- Scoped pull-request Docker validation to the primary Linux amd64 deployment target while keeping release images multi-architecture.

## [0.4.13] - 2026-06-22

### Security
- Updated dependency locks for patched `form-data`, `undici`, and `vite` releases.

### Changed
- Updated server dependencies: `better-sqlite3`, `node-cron`, `playwright`, `@vitest/coverage-v8`, `eslint`, `eslint-plugin-security`, and `vitest`.
- Updated client dependencies: `@ant-design/icons`, `antd`, `axios`, `dayjs`, `i18next`, `react`, `react-dom`, `react-router`, `@types/node`, `@types/react`, `@vitest/coverage-v8`, `vite`, and `vitest`.
- Updated GitHub Actions checkout steps to `actions/checkout@v7`.

## [0.4.12] - 2026-06-01

### Fixed
- Skipped automatic punches when freee daily work records mark the date as full-day paid holiday, absence, special holiday, or a non-working day.
- Re-checked freee daily work records immediately before each scheduled punch so same-day leave updates are respected.

### Security
- Updated transitive server dependency locks for `brace-expansion` and `qs` to patched versions.

## [0.4.11] - 2026-05-17

### Changed
- Disabled Docker Buildx build-record uploads in CI and release workflows.

## [0.4.10] - 2026-05-17

### Security
- OAuth refresh failures now distinguish re-authorization-required errors from transient service failures.
- Revoked or expired OAuth authorization now pauses the remaining scheduled actions for the day and shows a clear dashboard/log status.
- OAuth token exchange and API calls now use bounded request timeouts and avoid logging response bodies.
- Added a public release privacy gate and security threat model for release validation.

### Fixed
- Prevented scheduled actions from being marked complete after failed punch attempts.
- Added bounded retry handling for transient OAuth refresh failures before pausing automation.
- Added daily schedule status fields so failed, skipped, retrying, and authorization-required states remain visible.

### Changed
- Updated server, client, test, lint, and Playwright dependencies to current safe versions.
- CI now runs dependency audit, server coverage, client coverage smoke, client build, E2E smoke, and GitHub pull-request multi-architecture Docker checks.
- Browser automation remains available for workflows that require freee Web, while API mode remains the lighter default path.

## [0.4.9] - 2026-03-17

### Fixed
- **Lunch break constraint**: Break duration now enforced to 60–90 minutes. Previously only capped at max 60min but allowed breaks shorter than 60min when random scheduling resolved close together.
- **DB migration safety**: Replaced silent try/catch column detection with explicit `PRAGMA table_info` checks. Real errors (I/O, corruption) are no longer swallowed.

### Improved
- **Holiday smart caching**: Replaced daily API polling with TTL-based caching (JP 30d / CN 14d for current year; shorter TTLs during Oct–Dec for next-year data). Proactive prefetch of next year's data during Q4.
- **Async task store persistence**: Batch operation tasks now persist to SQLite. Surviving container restarts, with interrupted tasks clearly marked. Enhanced 404 messages for expired/missing tasks.
- **DRY refactoring**: Extracted 6 helper methods in PunchBot (SPA navigation, form wait loop, screenshot capture, error detection, lifecycle wrapper, approval type constants).
- **UI polish**: Updated font stack (Plus Jakarta Sans), refined dashboard and login page styling.

### Changed
- **PunchBot rename**: Internal `FreeeBot` class renamed to `PunchBot` to better reflect the project identity.

## [0.4.8] - 2026-02-28

### Added
- **Monthly closing Playwright fallback**: When the freee API returns HTTP 400 with "役職、部門を利用する申請はWebから申請してください" (dept/role-based approval routing), the `/approval/monthly` endpoint now automatically falls back to submitting the form via Playwright web automation. New `submitMonthlyAttendanceClosingWeb(year, month)` export in `automation.js`.

### Fixed
- **Monthly closing duplicate detection**: The Playwright fallback previously threw an error when freee rejected the submission with "対象月は既に月次勤怠締め申請が行われています" (monthly closing already exists). Since the goal state is already achieved, this is now treated as success (`alreadySubmitted: true`) instead of a failure.

## [0.4.7] - 2026-02-28

### Fixed
- **Monthly attendance closing (月度結算申請)**: freee API `/approval_requests/monthly_attendances` requires `target_year` (integer) and `target_month` (integer) as separate fields — the server was incorrectly sending `target_date` (date string), causing HTTP 400 `target_year, target_month が指定されていません`. Replaced with correct `target_year` + `target_month` fields.

### Changed
- **Dependency updates**: antd 6.3.0 → 6.3.1 (Select dropdown height fix), axios minor bump, react-router 7.13.0 → 7.13.1, rollup 4.57.1 → 4.59.0, minimatch 10.2.2 → 10.2.4

## [0.4.6] - 2026-02-22

### Fixed
- **Midnight hour boundary on Linux/Docker**: `Intl.DateTimeFormat` with `hour12: false` defaults to `hourCycle: h24` on Linux (range 1–24), returning `24` at midnight instead of `0`. This caused `curMin = 1484` and falsely triggered "Checkin window passed" at 00:xx JST on container startup. Fix: use `hourCycle: h23` explicitly (range 0–23, midnight = 0).
- **Regression tests**: Add `tests/timezone.test.mjs` (11 tests) covering midnight boundary, container startup scenario, and `nowInTz()` date injection.

## [0.4.5] - 2026-02-18

### Security
- **COEP**: Add `Cross-Origin-Embedder-Policy: credentialless` header
- **COOP removed**: Remove `Cross-Origin-Opener-Policy: same-origin` (added in v0.4.4) — it severs `window.opener` between OAuth callback popups and the main window, breaking the postMessage-based auto-refresh flow

### Added
- **RESET_DB**: New `RESET_DB=true` env var to reset database on container start (re-initializes with default admin/admin)

### Changed
- **Smart action planning**: Redesign `determineActionsForToday()` to independently evaluate each action based on current state, punch times, and scheduled times — replaces rigid switch/case logic
- **Japanese Labor Standards Act compliance**: Break scheduling now respects Art. 34 — skip break when expected work ≤6h (threshold: 361min), schedule when >6h
- **Two-tier retry**: Unknown state retry upgraded from simple 3×30s to two-tier: rapid (3×30s) + pre-checkin fallback (15min before checkin window)
- **Docker multi-stage build**: Reduce image size from ~4.2GB to ~2.5GB (Chromium-only, no build tools in runtime)

### Fixed
- **Dashboard stale status after company switch**: Switching OAuth company in Settings now immediately refreshes Dashboard status, punch progress, and logs for the new company — scheduler re-initializes to detect new company's state, and execution logs are filtered by active company (previously showed stale data from the previous company)
- **Dashboard derivedState**: Authoritative state now derived from freee punch times (not just detectCurrentState), fixing stale "next action" display after checkout
- **ManualTrigger consistency**: ManualTrigger reads from Redux store instead of separate API call, ensuring state consistency with Dashboard status card
- **Plan refresh after action**: `refreshPlanForCurrentState()` re-evaluates and cancels timers for now-invalid actions after any successful punch

## [0.4.4] - 2026-02-18

### Changed
- Upgrade Express 4→5, React 18→19, Ant Design 5→6, Vite 6→7, vitest 2→4, and all sub-dependencies
- Upgrade react-router-dom 6 → react-router 7 (package consolidation)

### Security
- Add `form-action 'self'` and `base-uri 'self'` to CSP
- Add `Permissions-Policy` header (disable geolocation, camera, microphone, USB, payment)
- Add `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`
- Static asset caching: hashed files 1 year immutable, favicon 1 day, index.html no-cache

### Fixed
- API token auto-recovery on 401 (handles token invalidation after Docker rebuild)
- Scheduler retries state detection up to 3 times on unknown state instead of permanently skipping
- Dashboard analysis reason now displays in user's locale instead of raw English

## [0.4.3] - 2026-02-17

### Added
- **Multi-break support**: Dashboard progress bar dynamically shows multiple break cycles (break_start/break_end pairs) from freee time_clocks data
- **Calendar multi-break display**: Calendar today cell renders all break pairs with numbering when >1 break exists
- **Real-time freee punch times**: Dashboard and Calendar display actual punch times from `getTodayTimeClocks()` API
- **Dynamic step derivation**: Progress bar steps built from freee data at runtime instead of hardcoded 4-step array

### Fixed
- **Dashboard progress bar mock mode**: Added fallback logic using execution logs + state inference when freee time_clocks unavailable
- **Skip status interaction**: Scheduler skips correctly become stale after manual intervention (no false "all done" display)
- **Defensive time sort**: `getTodayTimeClocks()` now sorts by datetime to guarantee chronological order

## [0.4.2] - 2026-02-12

### Fixed
- **Reverse proxy cookie handling**: `trust proxy` + protocol-aware `secure` flag — fixes login failure behind NPM/Cloudflare
- **504 timeout on batch operations**: Converted batch punch, batch leave, and batch withdraw to async task model with client-side polling — bypasses Cloudflare's 100s gateway timeout
- **Dashboard status stuck on "unknown"**: Scheduler now refreshes detected state via `detectCurrentState()` after successful auto-punch and manual trigger
- **Calendar showing "missing punch" after auto-punch**: CalendarView now auto-refreshes freee attendance data every 60 seconds

## [0.4.0] - 2026-02-12

### Added
- **Leave request system** — submit, track, and cancel paid holidays (full/half/hourly), special holidays, overtime, and absences
- **Multi-strategy leave fallback**: Direct API → Approval Request → Playwright web form, with per-month caching
- **Batch operations** — bulk leave requests, bulk withdrawal, and bulk approval/rejection for managers
- **Approval workflow enhancements** — incoming request list, batch approve/reject UI, Playwright-based withdrawal fallback
- **Holiday calendar** — CN tiaoxiu (调休) workday swap support, JP/CN country switcher, dynamic year selector
- **OAuth popup auto-refresh** with polling fallback for reliable authorization flow

### Security
- bcrypt password hashing with forced change on first login
- CSPRNG session tokens, login rate limiting (10 attempts / 15 min)
- CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff headers
- scrypt key derivation (N=16384, r=8, p=1) for AES-256-GCM encryption
- Sanitized server logs — no tokens, passwords, or PII in logs or client responses
- OAuth error body truncation to prevent information leakage
- Test DB isolation via `PUNCHPILOT_DB_PATH` env var

### Fixed
- Time format validation now rejects invalid hours/minutes (e.g., 25:00, 12:99)
- Break time validation uses correct window boundaries
- DB default pollution from pre-isolation test runs auto-corrected on startup
- OAuth popup `window.opener` null issue resolved with named window target

### Removed
- Kubernetes section from READMEs (k8s/ directory removed in 0.3.x)
- Dead code: ConfirmDialog, ConnectionModeCard, HolidaysPage (zero references)

## [0.3.0] - 2026-02-08

### Added
- **Batch attendance correction** with 4-tier auto-fallback strategy:
  1. Direct PUT (fastest)
  2. Approval request via API
  3. Time clock punches
  4. Playwright web form submission (most compatible)
- **Monthly strategy caching** - auto-detects the optimal strategy per month, resets on the 1st
- **Calendar view** with attendance status visualization and date selection for batch punch
- **Approval workflow** - submit, track, and withdraw work time correction requests
- **Monthly closing** submission support
- **Credential failure detection** - prompts user to update credentials when web login fails
- **i18n support** - English, Japanese, Chinese
- **Execution logs** for all operations (auto-punch, batch correction, approvals)

### Security
- **Key separation architecture** - encryption key stored in Docker named volume, separate from data
- AES-256-GCM encryption for all sensitive fields (credentials, OAuth tokens)
- Non-root container execution via `PUID`/`PGID` (LinuxServer.io convention)
- Screenshot auto-cleanup (7-day retention)
- Request timeout protection (30s API, 5min Playwright)

## [0.2.0] - 2025-12

### Added
- Web GUI dashboard with React + Ant Design
- OAuth2 integration with freee HR API
- Configurable auto-punch schedules via GUI
- Holiday detection (JP + CN national holidays, custom holidays)
- Browser automation mode via Playwright

## [0.1.0] - 2025-11

### Added
- Initial release based on [freee-checkin](https://github.com/newbdez33/freee-checkin)
- Docker containerized deployment
- Basic CLI punch automation
