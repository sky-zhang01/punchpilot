# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Non-root container execution (`ppuser`)
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
