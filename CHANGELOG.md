# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.5] - 2026-10-22

### Upgrade notes
- Upgrading from a version before 0.5.0? Read the 0.5.0 upgrade notes in CHANGELOG.md first.

### Changed
- The README in English, Chinese and Japanese has been rewritten for first-time users. It shows what PunchPilot does with screenshots, then walks through installation in six steps, each saying what you should see.
- Detailed rules, everyday tasks, freee app setup, remote access and configuration now have their own pages under `docs/`.
- Updated the Vite development dependency to clear a security advisory. The Docker image is not affected.
- Docker Compose now installs 0.5.5 by default.

## [0.5.4] - 2026-10-19

### Upgrade notes
- Upgrading from a version before 0.5.0? Read the 0.5.0 upgrade notes in CHANGELOG.md first.

### Fixed
- The browser tab icons and the installed-app icons now have a transparent background. Before, they sat on a white or light checkered square, which stood out in dark mode. The iPhone and iPad home-screen icon now fills its tile without a white border.

### Changed
- The README in English, Chinese and Japanese now opens with the PunchPilot logo. It also explains how scheduled punches are retried when freee is temporarily unavailable, and what `TRUST_PROXY` accepts.
- Docker Compose now installs 0.5.4 by default.

## [0.5.3] - 2026-10-15

### Upgrade notes
- Upgrading from a version before 0.5.0? Read the 0.5.0 upgrade notes in CHANGELOG.md first.

### Fixed
- When the freee API is temporarily unavailable or rate-limited, scheduled punches are retried for about an hour instead of failing for the rest of the day. Before each retry, PunchPilot checks freee's punch history so that a punch which went through, or one you made by hand, is not sent again, and it gives up rather than punch after the next scheduled action of the day.
- The check for leave and non-working days is retried the same way instead of pausing every remaining action after a single failed request.
- Screenshots work on storage that applies inherited permissions, such as TrueNAS datasets with ACLs, and startup no longer reports `SCREENSHOT_DIRECTORY_UNSAFE` there.

### Changed
- Docker Compose now installs 0.5.3 by default.

## [0.5.2] - 2026-10-14

### Upgrade notes
- Upgrading from a version before 0.5.0? Read the 0.5.0 upgrade notes in CHANGELOG.md first.
- If you set `PUNCHPILOT_LOG_DIR=/app/logs`, change it to `/app/data/logs` (the default) or add a `./logs:/app/logs` volume in `docker-compose.override.yml`; `docker-compose.yml` no longer mounts `./logs`.

### Changed
- Docker Compose now installs 0.5.2 by default.
- Rewrote the README in English, Chinese and Japanese around everyday situations, and shortened this changelog to user-facing notes.
- Updated dependencies.

### Fixed
- The factory reset tool now tells you to restart the container afterwards, or to recreate it when the initial administrator password comes from `.env`; it no longer claims that the container restarts by itself.
- Docker Compose no longer creates an unused `logs` folder; logs stay in `data/logs`.
- The container build fetches its pinned SQLite library from Debian's permanent snapshot archive, so rebuilding a release no longer depends on packages that Debian may remove.

## [0.5.1] - 2026-10-11

### Fixed
- Fixed publishing of the multi-architecture container image. There are no application changes since 0.5.0.

### Changed
- Docker Compose now installs 0.5.1 by default.

## [0.5.0] - 2026-10-10

### Upgrade notes
- No container image was published for 0.5.0; use 0.5.1 or later.
- **Remote access:** plain `http://` access from other devices no longer works. To use PunchPilot from anything other than `localhost`, put it behind an HTTPS reverse proxy, set `PUNCHPILOT_PUBLIC_ORIGIN` to that address and set `TRUST_PROXY`, because forwarded headers are no longer trusted by default. Register `https://<address>/api/config/oauth-callback` in your freee app, and sign in at that address instead of `localhost`.
- **Docker Compose:** Compose now downloads the published image and uses the bundled browser sandbox profile. If you changed `docker-compose.yml` (for example `PUID`/`PGID` or the port), move those values to `.env`, run `git checkout docker-compose.yml`, then `git pull`. `PUID`/`PGID` can no longer be 0.
- **freee Web login:** after upgrading, open **Settings → freee Web Login**, enter your password again together with the exact company name shown in freee, and save. PunchPilot verifies it when you save. Until then, actions that go through freee Web stop and ask for the company name.
- **New installations** create a one-time administrator password on first start instead of using a shared default. The README explains how to read it.
- Screenshots of the automated browser are now off by default (`BROWSER_SCREENSHOTS`).
- Logs recorded before 0.5.0 stay in the database but are no longer shown in Logs or the calendar.

### Fixed
- Days with approved full-day leave are skipped again, including special leave and combined leave.
- Punches and requests sent through freee Web are reported as successful only when PunchPilot can confirm them.
- Withdrawals affect only your own requests that can still be cancelled, and duplicate leave or correction requests for the same date are no longer submitted.
- After switching freee companies, the dashboard and logs show only the selected company's data, including actions that finish while you switch.
- A schedule change or a revoked authorization now takes effect immediately, even for an action that is about to run.
- Automatic punches pause when freee returns attendance data that PunchPilot does not recognize, instead of treating the day as empty.
- Batch corrections keep the dates already finished if the job is interrupted.
- Fixed punch correction choosing its submission method from the previous day's record between midnight and 09:00 Japan time.
- If PunchPilot starts up to five minutes after the scheduled check-in time, it now checks in right away.
- Improved stability of the automated browser after crashes and timeouts.

### Security
- Sign-in sessions are stored only as one-way hashes, and existing sessions are migrated automatically. Sign-in timing no longer reveals whether a username exists.
- Browser screenshots require sign-in to view, and sign-in pages are never captured.
- Stricter checks on the encryption key, the database files and the data folder permissions.
- Error messages no longer include content from freee pages or local file paths.
- Before submitting anything through freee Web, PunchPilot checks that it targets the intended company, employee, date and request.
- The automated browser no longer receives PunchPilot's secrets through its environment. In the standard Docker Compose setup, the pages it opens run inside Chromium's sandbox.
- The container no longer accepts 0 or invalid `PUID`/`PGID` values.
- Release images are scanned for vulnerabilities before publication. New dependency versions are adopted after a seven-day waiting period, except for security fixes.
- Updated the container's system libraries and removed unused components.

### Changed
- Runs on Node.js 24 LTS. Running from source requires Node.js 24.15 or newer and npm 12.2.
- Actions through freee Web are faster, because the browser session is reused between nearby actions.
- Stopping or updating the container waits for running punches and batch jobs to finish, for up to about nine minutes.
- Batch correction no longer replays individual clock punches for past days, so a failure cannot leave a day half-corrected. If your company turns off direct edits and its approval route cannot be used through the API, batch correction now needs the freee Web login.
- Smaller container image.
- Updated dependencies.

## [0.4.14] - 2026-07-01

### Fixed
- Monthly closing treats an already-submitted month as done.
- Monthly closing explains clearly when it needs the freee Web login and the login is missing or wrong.

### Changed
- Updated dependencies.

## [0.4.13] - 2026-06-22

### Security
- Updated dependencies, including fixes for known vulnerabilities.

## [0.4.12] - 2026-06-01

### Fixed
- Automatic punches are skipped when freee marks the day as full-day paid leave, absence, special leave or a non-working day.
- freee day records are checked again right before each scheduled punch, so leave added on the same day is respected.

### Security
- Updated dependencies to fix known vulnerabilities.

## [0.4.11] - 2026-05-17

### Changed
- Build maintenance only; no application changes.

## [0.4.10] - 2026-05-17

### Fixed
- Scheduled actions are no longer marked as done after a failed punch.
- Temporary freee authorization errors are retried before automation pauses.
- The dashboard shows when a scheduled action failed, was skipped, is retrying or needs re-authorization.

### Security
- An expired or revoked freee authorization pauses that day's remaining automatic punches and shows a clear status, instead of failing silently.
- Requests to freee time out instead of hanging, and freee responses are no longer written to logs.

### Changed
- Updated dependencies.

## [0.4.9] - 2026-03-17

### Fixed
- Lunch breaks are always 60–90 minutes; previously they could be shorter than 60 minutes.
- Database upgrades stop with an error on real disk problems instead of continuing silently.

### Changed
- Holiday calendars are cached and refreshed less often, and next year's holidays are downloaded in advance from October.
- Batch jobs survive container restarts, and interrupted jobs are clearly marked.
- Refreshed the fonts and styling of the dashboard and sign-in page.

## [0.4.8] - 2026-02-28

### Added
- Monthly closing falls back to the freee Web form when freee requires Web submission, for example for approval routes based on department or position.

### Fixed
- Monthly closing no longer reports an error when the month was already submitted.

## [0.4.7] - 2026-02-28

### Fixed
- Fixed monthly closing requests being rejected by freee.

### Changed
- Updated dependencies.

## [0.4.6] - 2026-02-22

### Fixed
- Fixed the check-in being wrongly treated as missed when the container started between midnight and 01:00 Japan time.

## [0.4.5] - 2026-02-18

### Added
- `RESET_DB=true` erases all PunchPilot data every time the container starts while it is set. Use it once, then remove it.

### Changed
- Each remaining action is planned from the current freee state, so restarting in the middle of the day continues correctly.
- Breaks are scheduled only when the expected workday is longer than six hours, following Japan's Labor Standards Act (Article 34).
- When the attendance state cannot be read, PunchPilot retries quickly and once more 15 minutes before the check-in window.
- Smaller container image.

### Fixed
- Switching freee companies refreshes the dashboard immediately and shows only that company's logs.
- The dashboard's next action and the manual buttons now match the actual freee punches.
- Fixed the freee authorization popup not refreshing the main window.

### Security
- Adjusted browser security headers.

## [0.4.4] - 2026-02-18

### Changed
- Upgraded core frameworks and dependencies.
- Faster page loads through better browser caching.

### Security
- Added stricter browser security headers.

### Fixed
- Recovers automatically when a saved freee token becomes invalid.
- Retries reading the attendance state instead of skipping the day after a single failure.
- The dashboard explains its analysis in your language.

## [0.4.3] - 2026-02-17

### Added
- The dashboard and calendar show your actual punch times from freee, including several breaks per day.

### Fixed
- The progress bar works even when freee punch data is unavailable.
- Fixed a false "all done" display after a manual punch.

## [0.4.2] - 2026-02-12

### Fixed
- Fixed sign-in failing behind a reverse proxy.
- Batch punch, leave and withdrawal run in the background with progress updates, so they no longer time out behind a reverse proxy.
- The dashboard status no longer stays "unknown" after a punch.
- The calendar refreshes automatically, so new punches appear without reloading the page.

## [0.4.0] - 2026-02-12

### Added
- Leave requests: submit, track and cancel paid leave (full day, half day or hourly), special leave, overtime and absence.
- Batch operations: bulk leave requests, bulk withdrawal, and bulk approval or rejection for managers.
- A list of incoming requests for approvers.
- Holiday calendar with Japan and China, including Chinese make-up workdays.
- More reliable freee authorization popup.

### Security
- Passwords are hashed with bcrypt, and the password must be changed at first sign-in.
- Sign-in rate limiting and standard browser security headers.
- Stronger encryption for saved credentials.
- Tokens, passwords and personal data are kept out of logs and error messages.

### Fixed
- Invalid times such as 25:00 are rejected.
- Break time validation uses the correct window.

### Removed
- Kubernetes deployment instructions; Docker Compose is the supported deployment.

## [0.3.0] - 2026-02-08

### Added
- Batch attendance correction for missed days, automatically choosing a submission method that works for your account.
- Calendar view with attendance status.
- Work-time correction requests that you can submit, track and withdraw.
- Monthly closing.
- A prompt to update your freee Web login when it stops working.
- English, Japanese and Chinese user interface.
- Execution logs for all actions.

### Security
- Saved credentials and freee tokens are encrypted, and the encryption key is stored separately from the data.
- The container runs as a non-root user (`PUID`/`PGID`).
- Debug screenshots are deleted after seven days.
- Timeouts for freee requests and browser automation.

## [0.2.0] - 2025-12

### Added
- Web dashboard.
- Connection to the freee HR API (OAuth2).
- Schedules configurable in the web dashboard.
- Holiday detection for Japan and China, plus custom holidays.
- Browser automation through the freee Web site.

## [0.1.0] - 2025-11

### Added
- Initial release based on [freee-checkin](https://github.com/newbdez33/freee-checkin).
- Docker container deployment.
- Basic command-line punch automation.
