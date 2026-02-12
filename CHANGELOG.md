# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Non-root container execution (UID 568, TrueNAS `apps` compatible)
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
