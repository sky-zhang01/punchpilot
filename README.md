# PunchPilot

Smart attendance automation for [freee HR](https://www.freee.co.jp/hr/). Runs as a self-hosted Docker app with a web dashboard.

[**中文**](README.zh-CN.md) | [**日本語**](README.ja.md)

## What it does

- **Auto clock-in/out** on a configurable schedule, skipping weekends and holidays (JP/CN)
- **Batch attendance correction** for missed days with one click
- **4-tier smart fallback**: Direct API > Approval Request > Time Clocks > Web form (Playwright)
- **Monthly strategy caching** to skip known-failing methods automatically
- **Approval workflow**: submit, track, and withdraw work time corrections
- **Web dashboard** with calendar view, execution logs, and real-time status

## Quick Start

```bash
# Clone the repo
git clone https://github.com/sky-zhang/punchpilot.git
cd punchpilot

# Configure
cp .env.example .env
# Edit .env — set GUI_PASSWORD at minimum

# Launch
docker compose up -d

# Open dashboard
open http://localhost:8681
```

On first login, use the password from `.env`. Then configure:
1. **OAuth credentials** — create a freee developer app and enter Client ID / Secret
2. **Authorize** — grant PunchPilot access to your freee HR account
3. **Schedule** — set your work hours and auto-punch times

## Architecture

```
┌──────────────┐     ┌──────────────────────────────────┐
│   Browser    │────▶│         PunchPilot (Docker)       │
│  Dashboard   │     │                                    │
└──────────────┘     │  Express API ─── React (Ant Design)│
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │ SQLite  │    │  Playwright    │ │
                     │  │  (data) │    │  (web fallback)│ │
                     │  └─────────┘    └───────────────┘ │
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │Scheduler│    │ freee HR API   │ │
                     │  │ (cron)  │    │  (OAuth2)      │ │
                     │  └─────────┘    └───────────────┘ │
                     └──────────────────────────────────┘
```

**Tech stack**: Node.js, Express, React, Ant Design, Playwright, SQLite, Docker

## Batch Attendance Strategy

When correcting missed attendance, PunchPilot tries 4 strategies in order:

| Strategy | Method | Speed | Requires |
|----------|--------|-------|----------|
| 1. Direct | `PUT /work_records` | Instant | Write permission |
| 2. Approval | `POST /approval_requests` | Instant | Approval route |
| 3. Time Clock | `POST /time_clocks` | Sequential | Basic access |
| 4. Web Form | Playwright browser | ~20s/entry | freee web credentials |

Once a month, PunchPilot detects which strategy works for your company and caches it. Failed strategies are skipped automatically until the next month.

## Security

- **Encryption**: AES-256-GCM for all stored credentials (freee password, OAuth tokens)
- **Key isolation**: Encryption key lives in a Docker named volume, separate from data bind mount
- **Non-root**: Container runs as unprivileged user `ppuser`
- **No external calls**: All data stays between you and freee's servers

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GUI_PASSWORD` | (required) | Web dashboard login password |
| `TZ` | `Asia/Tokyo` | Container timezone |
| `PORT` | `8681` | Server port |

### Docker Volumes

| Path | Type | Purpose |
|------|------|---------|
| `./data` | Bind mount | SQLite database, logs |
| `./screenshots` | Bind mount | Debug screenshots |
| `keystore` | Named volume | Encryption key (isolated) |

## Development

```bash
# Install dependencies
npm install && cd client && npm install && cd ..

# Start dev server (auto-reload)
npm run dev

# Run tests
npm test

# Build client
cd client && npx vite build
```

## Kubernetes

Kubernetes manifests are in the `k8s/` directory. See the YAML files for namespace, PVC, secret, and deployment configuration.

## Acknowledgments

This project was inspired by and built upon [freee-checkin](https://github.com/newbdez33/freee-checkin) by [@newbdez33](https://github.com/newbdez33). The original project provided the foundation for Playwright-based freee attendance automation. PunchPilot extends it with a web GUI, OAuth API integration, multi-strategy batch correction, and enterprise security features.

## License

[MIT](LICENSE)
