# PunchPilot Security Threat Model

## Scope

PunchPilot is a self-hosted attendance automation service for freee HR. The protected system includes the web UI, Express API, scheduler, SQLite database, encrypted settings, OAuth tokens, optional browser automation credentials, screenshots, logs, and Docker runtime data.

## Assets

- Application login credentials and active session cookies.
- freee OAuth client secret, access token, refresh token, company ID, employee ID, and user profile metadata.
- Optional freee Web login credentials used only for browser-based fallback workflows.
- Attendance actions, daily schedules, execution logs, screenshots, and correction request data.
- The local encryption key stored outside the bind-mounted data directory.

## Trust Boundaries

- Browser to Express API: authenticated with an httpOnly session cookie.
- Express API to SQLite: trusted local process boundary; data is still encrypted for stored secrets.
- Express API to freee API: OAuth bearer token boundary.
- Browser automation fallback to freee Web: higher-risk credential boundary; used only when API-based workflows cannot complete a required operation.
- Docker host to container: persistent data, logs, screenshots, and keystore are separate mounts.
- CI and release workflows: public artifacts must pass dependency, privacy, and build checks before publication.

## Main Abuse Paths

- Stolen session cookie or default account left unchanged.
- Brute-force login attempts against the local web UI.
- OAuth refresh token expiry or revocation causing silent missed scheduled attendance actions.
- Token or password disclosure through logs, screenshots, release notes, or CI output.
- Browser automation fallback using stale credentials and repeatedly failing without clear user action.
- Cross-architecture Docker drift between local development and deployment.
- Public releases accidentally including local paths, internal hosts, or secret-like values.

## Controls

- First login forces the default account to change username and password.
- Sessions are random, stored server-side, and sent through httpOnly cookies.
- Login attempts are rate limited per source IP.
- Stored credentials and OAuth tokens use AES-256-GCM with an installation-local key.
- The encryption key lives in the keystore mount, separate from the application data bind mount.
- OAuth token refresh failures are classified as either re-authorization-required or transient.
- Re-authorization-required failures pause the remaining scheduled actions for the day and surface status in the dashboard and logs.
- Transient OAuth refresh failures use bounded retries before pausing automatic actions.
- Security headers include CSP, frame denial, content sniffing protection, referrer policy, resource policy, permissions policy, and HTTPS-only HSTS.
- Release workflows scan tracked public files for secret-like values, private IPs, local home paths, and configured forbidden hostnames.
- CI runs security lint, dependency audit, unit coverage, client build, E2E smoke, and multi-architecture Docker checks for public pull requests.

## Residual Risk

- Browser automation remains heavier and more failure-prone than API calls, but some freee workflows require it. It should stay as a constrained fallback rather than the default control path.
- Screenshots can contain sensitive attendance page content. They are retained only for operational debugging and are automatically cleaned up.
- Operators must configure HTTPS at the reverse proxy if exposing the service beyond a trusted local network.
- OAuth authorization can still expire or be revoked externally; the system can detect and pause, but the user must re-authorize.

## Release Gate

Before release, run the dependency audit, security lint, unit coverage, client build, E2E smoke, public release privacy gate, and multi-architecture Docker build. Changelog and release notes must describe product changes only and must not include internal development process, local paths, internal hosts, tokens, or private tracker references.
