# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | Yes       |
| 0.3.x   | No        |
| < 0.3   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in PunchPilot, please report it through [GitHub Security Advisories](https://github.com/sky-zhang01/punchpilot/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Design

PunchPilot handles sensitive credentials (freee OAuth tokens, user passwords) and takes the following precautions:

- **Encryption**: AES-256-GCM for all stored credentials; key derived via scrypt (N=16384, r=8, p=1)
- **Key isolation**: Encryption key stored in a Docker named volume, separate from the data bind mount
- **Auth hardening**: bcrypt password hashing, forced password change on first login, CSPRNG session tokens, login rate limiting (10/15min)
- **Security headers**: CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff
- **Non-root execution**: Container runs as unprivileged user `ppuser`
- **Sanitized logs**: No tokens, passwords, or PII in server logs or client error responses
- **No external telemetry**: All data stays between you and freee's servers
