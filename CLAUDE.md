# PunchPilot — Technical Reference

## Tech Stack

- **Backend**: Node.js 24 (ES modules), Express 5, SQLite (better-sqlite3), Playwright
- **Frontend**: React 19, Ant Design 6, Vite 8, TypeScript
- **Auth**: bcryptjs password hashing, one-way hashed session tokens, AES-256-GCM credential encryption (scrypt KDF)
- **Infra**: Docker (multi-arch amd64/arm64), PUID/PGID privilege dropping via gosu

## Project Layout

```
server/
  server.js          # Entry point (Express listen, PORT 8681)
  app.js             # Express app setup, middleware, route mounting, write-origin guard
  public-origin.js   # Canonical public origin, OAuth callback URL, Secure cookie/HSTS decisions
  db.js              # SQLite schema, migrations, seed data
  crypto.js          # AES-256-GCM encrypt/decrypt, scrypt key derivation
  auth.js            # Session auth middleware
  scheduler.js       # Daily plan and scheduled punch execution
  automation/        # Punch execution: freee API client paths, Web automation, mock mode, scheduling rules
  freee-api.js       # freee HR API client (OAuth, time_clocks, work records)
  work-record-status.js # Leave and non-working-day classification from freee work records
  holiday.js         # JP/CN holiday detection and caching
  paths.js           # Data, keystore, log and screenshot locations
  reset-password.js  # Factory reset tool (run with docker exec)
  routes/
    api-status.js    # GET /api/status (state, logs, today_punch_times)
    api-auth.js      # Login, logout, password change
    api-config.js    # OAuth config, freee Web login, schedule settings
    api-holidays.js  # Holiday calendar data
    api-logs.js      # Execution log queries
    api-schedule.js  # Schedule CRUD
    attendance/      # Corrections, leave and work requests, approvals, monthly closing

client/src/
  pages/             # Dashboard, Calendar, Holidays, Logs, Settings, Login, password pages
  components/
    dashboard/       # ManualTrigger
    layout/          # AppLayout (sidebar, header)
    logs/            # CalendarView, request modals, ApprovalSection, MonthlySummary
    settings/        # OAuthConfigCard, BrowserAccountCard, MockModeCard, ScheduleConfigCard
  locales/
    en.ts, ja.ts, zh.ts # i18n translation files

tests/
  *.test.mjs         # Vitest unit and integration tests (run via: npm test)
```

## Key Commands

```bash
# Unit and integration tests
npm test

# Build the web UI (the server serves client/dist)
npm --prefix client run build

# Dev server (backend, auto-reload)
npm run dev

# Run the published image
docker compose up -d

# Build and run a local image instead
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Git Conventions

- **Branch naming**: `feature/v{X.Y.Z}-{description}` for feature branches
- **Commit style**: `feat:`, `fix:`, `chore(deps):`, `docs:` prefixes
- **PR flow**: Feature branch → PR to `main` → independent review → merge; releases are cut from version tags
- **Trilingual docs**: README.md (EN), README.zh-CN.md (ZH), README.ja.md (JA) — keep in sync

## Technical Notes

- **Remote access**: Without `PUNCHPILOT_PUBLIC_ORIGIN`, sign-in and other writes are accepted only from `localhost` pages; external origins must be HTTPS
- **Reverse proxy**: Forwarded headers are trusted only for peers listed in `TRUST_PROXY`; Secure cookies and HSTS follow `PUNCHPILOT_PUBLIC_ORIGIN`
- **Port**: Default 8681, configurable via `PORT` env var
- **freee state machine**: WORKING ↔ ON_BREAK cycles — supports multiple breaks per day naturally
- **Today punch times**: `getTodayTimeClocks()` returns chronological array from freee API; Dashboard derives steps dynamically
- **Mock mode**: On by default in a fresh database (Settings → Mock Mode); simulates punches only, while calendar requests still go to freee once it is connected
- **Scheduler skip logic**: `terminalActions` holds actions done or irreversibly skipped today; `skippedActions` adds actions the current freee state makes unnecessary. After a successful manual action, `refreshPlanForCurrentState()` re-detects the state and cancels timers that no longer apply; a check-in after check-out re-opens `checkout`
- **Dashboard skip display**: `allSkippedNoEvidence` in `DashboardPage.tsx` treats skipped steps as final only when no step has a success log or state evidence; otherwise remaining skips are stale because the user intervened manually
