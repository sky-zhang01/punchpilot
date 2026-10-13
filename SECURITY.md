# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in PunchPilot, please report it through [GitHub Security Advisories](https://github.com/sky-zhang01/punchpilot/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Design

PunchPilot handles sensitive data: your freee login, freee API tokens and your attendance records. It is designed around these protections:

- **Your data stays with you.** PunchPilot runs on your own machine and itself connects only to freee and to public holiday calendars. There is no telemetry.
- **Encrypted credentials.** The freee password, the API client secret and tokens are encrypted (AES-256-GCM). The encryption key is kept in a separate Docker volume from the database.
- **Protected sign-in.** A one-time administrator password is created on first start and must be replaced. Passwords are hashed with bcrypt, sessions are stored only as one-way hashes, and repeated failed sign-in attempts are rate-limited.
- **Protection against cross-site requests.** Browser requests that sign in or change data are accepted only from pages served at `localhost`, or at the HTTPS address set in `PUNCHPILOT_PUBLIC_ORIGIN` once it is configured. Standard browser security headers are applied. This is not a network firewall: the port is reachable from your network, so restrict it with a firewall if you do not need access from other devices.
- **Safe failure.** When PunchPilot cannot confirm your attendance status, your leave or which freee account it is acting for, it pauses instead of punching.
- **Isolated browser automation.** The automated browser does not receive PunchPilot's secrets through its environment, and in the standard Docker Compose setup the pages it opens run inside Chromium's sandbox. Screenshots are off by default, require sign-in to view and are deleted after seven days.
- **Least privilege.** The container runs as a non-root user set by `PUID`/`PGID`.
- **Clean logs and errors.** Tokens, passwords and freee page content are kept out of logs and error messages.
- **Dependency checks.** Dependencies are installed with integrity checks, and release images are scanned for vulnerabilities before publication.
