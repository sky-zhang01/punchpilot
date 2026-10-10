# PunchPilot

Smart attendance automation for [freee HR](https://www.freee.co.jp/hr/). Runs as a self-hosted Docker app with a web dashboard.

[**中文**](README.zh-CN.md) | [**日本語**](README.ja.md)

## What it does

- **Auto clock-in/out** on a configurable schedule, skipping weekends and holidays (JP/CN)
- **Manual trigger** — one-click clock-in, clock-out, break start, and break end from the dashboard
- **Multi-break support** — tracks unlimited break cycles per day; dashboard and calendar display each break pair dynamically
- **Real-time punch status** — dashboard shows actual punch times from freee, with live progress tracking
- **Batch attendance correction** for missed days with one click
- **Leave requests** — submit, track, and cancel paid holidays, special holidays, overtime, and absences
- **Batch operations** — bulk leave requests, bulk withdrawal, and bulk approval/rejection
- **3-path safe fallback**: Direct API > Approval Request > verified Web form (Playwright)
- **Monthly strategy caching** to skip known-failing methods automatically
- **OAuth authorization guardrails** — pauses automation and asks for re-authorization instead of silently missing scheduled actions
- **Approved leave guard** — re-checks freee before every scheduled action through the Public API when available or the authenticated Web attendance view in Browser-only mode
- **Approval workflow**: submit, track, and withdraw work time corrections; manager batch approve/reject
- **Holiday calendar** with JP national holidays and CN holidays (including tiaoxiu/workday swaps)
- **Web dashboard** with calendar view, execution logs, and real-time status
- **Multi-language** UI — English, Japanese, Chinese

## Quick Start

```bash
# Clone the repo
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# Create the local configuration file
cp .env.example .env

# Launch
docker compose up -d

# Open dashboard
open http://localhost:8681
```

On first start, PunchPilot creates a high-entropy one-time password for the `admin` user. Read it without copying it into logs, then sign in and change both username and password:

```bash
docker compose exec punchpilot cat /app/keystore/initial-admin-password
```

The bootstrap file is removed after the password change. Then configure:
1. **Action transport** — use OAuth API mode when your account has API access, or Browser mode with your freee Web credentials when it does not
2. **Leave guard** — OAuth read access is preferred when available; Browser-only mode verifies leave through the authenticated freee Web attendance view
3. **Schedule** — set your work hours and auto-punch times

Without OAuth authorization, Browser mode verifies the current date through the same authenticated Web session before it punches. If the attendance record cannot be positively identified or its structure is unsupported, the scheduled action is paused rather than sent.

After saving Browser credentials, or after upgrading an existing Browser-mode installation to v0.5.0, run **Verify** once in Settings. Scheduled actions remain paused until PunchPilot confirms the exact freee employee identity.

## Architecture

```
┌──────────────┐     ┌────────────────────────────────────┐
│   Browser    │────▶│         PunchPilot (Docker)        │
│  Dashboard   │     │                                    │
└──────────────┘     │  Express API ─── React (Ant Design)│
                     │       │                            │
                     │  ┌────┴────┐    ┌────────────────┐ │
                     │  │ SQLite  │    │  Playwright    │ │
                     │  │  (data) │    │   (Web mode)   │ │
                     │  └─────────┘    └────────────────┘ │
                     │       │                            │
                     │  ┌────┴────┐    ┌────────────────┐ │
                     │  │Scheduler│    │ freee HR API   │ │
                     │  │ (cron)  │    │  (OAuth2)      │ │
                     │  └─────────┘    └────────────────┘ │
                     └────────────────────────────────────┘
```

**Tech stack**: Node.js, Express 5, React 19, Ant Design 6, Vite 8, Playwright, SQLite, Docker

## Batch Attendance Strategy

When correcting missed attendance, PunchPilot tries three safe strategies in order:

| Strategy | Method | Speed | Requires |
|----------|--------|-------|----------|
| 1. Direct | `PUT /work_records` | Instant | Write permission |
| 2. Approval | `POST /approval_requests` | Instant | Approval route |
| 3. Web Form | Playwright browser | Browser-dependent | freee Web credentials |

Once a month, PunchPilot detects which strategy works for your company and caches it. Sequential time-clock writes are not used for historical correction because a partial failure cannot be rolled back.

## Security

- **Encryption**: AES-256-GCM for all stored credentials (freee password, OAuth tokens); key derived via scrypt
- **Key isolation**: Encryption key in Docker named volume, physically separate from data bind mount
- **Auth hardening**: high-entropy one-time bootstrap password, bcrypt password hashing, forced password change on first login, CSPRNG sessions, login rate limiting (10/15min)
- **Session storage**: Only one-way session-token hashes are stored in SQLite
- **Security headers**: CSP (with form-action, base-uri), HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Permissions-Policy, COEP, CORP
- **OAuth fail-closed behavior**: expired or revoked authorization pauses scheduled automation and surfaces re-authorization status in the dashboard and logs
- **Leave guard fail-closed behavior**: an unverified API or Browser-mode attendance record pauses scheduled actions instead of risking an unwanted punch
- **Static caching**: Hashed assets (1 year immutable), favicon (1 day), index.html (no-cache)
- **Non-root**: Container rejects zero/invalid `PUID`/`PGID` values and drops privileges before starting the app (default 1000, set to 568 for TrueNAS)
- **No telemetry**: Credentials and attendance data are sent only to freee; the holiday module fetches public calendar data
- **Browser artifacts**: Screenshots are off by default; opt-in files require authentication and expire automatically
- **Browser isolation**: The standard Compose deployment runs Chromium as non-root with its namespace/seccomp sandbox enabled
- **Dependency provenance**: npm registry signatures, SHA-512 lock integrity, and a seven-day release-age gate are checked before release; urgent security exceptions must be exact, public, and expiring
- **Sanitized errors**: Tokens, passwords, credential-form screenshots, and raw freee page bodies are not exposed in client errors

## Platform Support

PunchPilot is distributed as a multi-architecture Docker image.

| Architecture | Platform | Example Hardware |
|---|---|---|
| `linux/amd64` | x86_64 | Intel/AMD servers, PCs, most cloud VMs |
| `linux/arm64` | aarch64 | Apple M-series (M1/M2/M3/M4), AWS Graviton, Raspberry Pi 4+ |

> **Windows / macOS**: Run the same Linux image via [Docker Desktop](https://www.docker.com/products/docker-desktop/) (uses a lightweight Linux VM internally).

```bash
# Pull the versioned image
docker pull ghcr.io/sky-zhang01/punchpilot:0.5.0

# Compose pulls the same versioned multi-architecture image
docker compose pull
docker compose up -d

# For strict production immutability, use the manifest digest from the release notes
PUNCHPILOT_IMAGE=ghcr.io/sky-zhang01/punchpilot@sha256:<digest> docker compose up -d
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | `Asia/Tokyo` | Container timezone |
| `PORT` | `8681` | Server port |
| `PUID` / `PGID` | `1000` | Runtime user/group; set both to `568` for the standard TrueNAS Apps identity |
| `PUNCHPILOT_IMAGE` | `ghcr.io/sky-zhang01/punchpilot:0.5.0` | Published image tag or release manifest digest used by Compose |
| `TRUST_PROXY` | disabled | Trusted reverse-proxy IP/CIDR entries or `loopback`, `linklocal`, and `uniquelocal`; forwarded headers are ignored when unset |
| `PUNCHPILOT_PUBLIC_ORIGIN` | loopback only | Canonical HTTPS origin for non-loopback access; anchors write validation, Secure cookies, HSTS, and the OAuth callback instead of trusting request headers |
| `OAUTH_REDIRECT_URI` | derived | Optional exact freee callback URI on the same canonical origin; path must be `/api/config/oauth-callback` |
| `SHUTDOWN_GRACE_MS` | `510000` | Time allowed for the current scheduler, browser, batch, account, and HTTP operations to drain during shutdown |
| `APP_SECRET` | generated in `keystore` | Optional encryption-secret override, minimum 32 bytes; once persisted it must exactly match the existing keystore secret or startup stops |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD` | unset | Optional bootstrap password, minimum 16 bytes; prefer the file-based default because container environments can be inspected |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE` | `/app/keystore/initial-admin-password` | Bootstrap secret file; generated with mode `0600` when absent and removed after first password change |
| `BROWSER_SCREENSHOTS` | `off` | `off`, `errors`, or `all`; enable only for controlled diagnostics |
| `CHROMIUM_SANDBOX` | `false` | Enables Chromium's internal sandbox; the bundled Compose file sets this to `true` with the reviewed seccomp profile |
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` | Close an idle Chromium process after this interval |
| `BROWSER_SESSION_TTL_MS` | `28800000` | In-memory Web session reuse lifetime; never written to disk |
| `AUTOMATION_QUEUE_TIMEOUT_MS` | `540000` | Maximum wait for a serialized account or browser operation; longer than the single-operation deadline |
| `AUTOMATION_OPERATION_TIMEOUT_MS` | `480000` | Hard deadline for one serialized browser operation; values outside `1..480000` stop startup |

The bundled Compose configuration enables Chromium's sandbox with a pinned Playwright seccomp profile, minimal startup capabilities, and `no-new-privileges`. For image-only platforms, set `CHROMIUM_SANDBOX=true` only when the same profile is applied by the container runtime. Do not substitute `seccomp=unconfined` or `SYS_ADMIN` in production.

Set `PUNCHPILOT_PUBLIC_ORIGIN` when the dashboard is reached through a hostname or reverse proxy. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]`; external origins must use HTTPS. If `OAUTH_REDIRECT_URI` is set, its origin must match.

### Docker Volumes

| Path | Type | Purpose |
|------|------|---------|
| `./data` | Bind mount | SQLite database, logs |
| `./screenshots` | Bind mount | Opt-in authenticated debug screenshots |
| `keystore` | Named volume | Encryption key and one-time administrator bootstrap file (isolated) |

## Development

Local development requires Node.js 24.15 or newer in the Node 24 line and npm 12.2.0. The included `.nvmrc`, package engine checks, CI, and container build enforce the same toolchain.

```bash
# Install the reviewed npm line bundled into CI and the image builder
npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund

# Install dependencies
npm ci --ignore-scripts
npm --prefix client ci --ignore-scripts
npm run audit:release-age

# Start dev server (auto-reload)
npm run dev

# Run tests
npm test

# Run coverage and E2E smoke
npm run test:coverage
npm --prefix client run test:coverage
npm --prefix client run build
npm run test:e2e

# Build client
cd client && npx vite build

# Build a local image instead of pulling the published release
cd ..
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Public release verification is documented in [docs/releases.md](docs/releases.md). Preview merged branch cleanup candidates with:

```bash
npm run housekeeping:branches -- --fetch --remote origin --include-local
```

## Acknowledgments

This project was inspired by and built upon [freee-checkin](https://github.com/newbdez33/freee-checkin) by [@newbdez33](https://github.com/newbdez33). The original project provided the foundation for Playwright-based freee attendance automation. PunchPilot extends it with a web GUI, OAuth API integration, multi-strategy batch correction, and enterprise security features.

## License

[MIT](LICENSE)
