# PunchPilot — Technical Reference

## Tech Stack

- **Backend**: Node.js (ES modules), Express 5, SQLite (better-sqlite3 12), Playwright
- **Frontend**: React 19, Ant Design 6, Vite 7, TypeScript
- **Auth**: bcrypt password hashing, CSPRNG session tokens, AES-256-GCM credential encryption (scrypt KDF)
- **Infra**: Docker (multi-arch amd64/arm64), PUID/PGID privilege dropping via gosu

## Project Layout

```
server/
  server.js          # Entry point (Express listen, PORT 8681)
  app.js             # Express app setup, middleware, route mounting
  db.js              # SQLite schema, migrations, seed data
  crypto.js          # AES-256-GCM encrypt/decrypt, scrypt key derivation
  auth.js            # Session auth middleware
  scheduler.js       # Cron-based auto-punch scheduling
  automation.js      # Punch execution logic (detect state, execute action)
  freee-api.js       # freee HR API client (OAuth, time_clocks, attendance)
  holiday.js         # JP/CN holiday detection
  logger.js          # Winston logger
  routes/
    api-status.js    # GET /api/status (state, logs, today_punch_times)
    api-attendance.js# Batch punch, batch leave, approval endpoints
    api-auth.js      # Login, logout, password change
    api-config.js    # OAuth config, schedule settings
    api-holidays.js  # Holiday calendar data
    api-logs.js      # Execution log queries
    api-schedule.js  # Schedule CRUD

client/src/
  pages/
    DashboardPage.tsx   # Main dashboard (status, progress bar, manual trigger, logs)
    CalendarPage.tsx     # Calendar + holidays wrapper
    LogsPage.tsx         # Full log viewer with filtering
    SettingsPage.tsx     # OAuth, schedule, system config
    HolidaysPage.tsx     # Holiday management (JP/CN)
    LoginPage.tsx        # Login form
  components/
    dashboard/           # ManualTrigger, StatusCard, etc.
    layout/              # AppLayout (sidebar, header, footer)
    logs/                # CalendarView, LogTable
    settings/            # OAuthSetup, ScheduleConfig
  locales/
    en.ts, ja.ts, zh.ts # i18n translation files

tests/
  *.test.mjs             # Vitest unit tests (run via: npx vitest run)
  phase5-integration.test.mjs  # Integration tests (run via: node tests/phase5-integration.test.mjs)
```

## Key Commands

```bash
# Unit tests (224 tests)
npx vitest run

# Integration tests (85 tests) — standalone script, excluded from vitest
node tests/phase5-integration.test.mjs

# Dev server (backend, auto-reload)
npm run dev

# Build frontend
cd client && npx vite build

# Docker build
docker compose build

# Docker run
docker compose up -d
```

## Git Conventions

- **Branch naming**: `feature/v{X.Y.Z}-{description}` for feature branches
- **Commit style**: `feat:`, `fix:`, `chore(deps):`, `docs:` prefixes
- **PR flow**: Feature branch → PR to `main` → merge → tag `v{X.Y.Z}` → CI auto-release
- **Trilingual docs**: README.md (EN), README.zh-CN.md (ZH), README.ja.md (JA) — keep in sync

## Technical Notes

- **Trust proxy**: `app.set('trust proxy', 1)` required for reverse proxy (cookie secure flag)
- **Cookie behavior**: `secure` flag is protocol-aware (`req.protocol === 'https'`)
- **Port**: Default 8681, configurable via `PORT` env var
- **freee state machine**: WORKING ↔ ON_BREAK cycles — supports multiple breaks per day naturally
- **Today punch times**: `getTodayTimeClocks()` returns chronological array from freee API; Dashboard derives steps dynamically
- **Mock mode**: Activated when freee OAuth not configured; uses execution logs for state inference fallback
- **Scheduler skip logic**: `allSkippedNoEvidence` flag — skips become stale after manual intervention
