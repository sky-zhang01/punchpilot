# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.5] - 2026-02-18

### Security
- **COEP**: Add `Cross-Origin-Embedder-Policy: credentialless` header

### Changed
- **Docker multi-stage build**: Reduce image size from ~4.2GB to ~2.5GB (Chromium-only, no build tools in runtime)

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
- **Skip/evidence interaction**: Scheduler skips correctly become stale after manual intervention (no false "all done" display)
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
