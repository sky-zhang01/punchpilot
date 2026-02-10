# PunchPilot Security Audit Report

**Date:** 2026-02-10
**Version:** 0.3.2
**Auditor:** Automated + Manual Review

## Executive Summary

Overall risk: **MEDIUM** — suitable for single-user internal deployment. Three high-priority issues identified in OAuth implementation should be addressed before any external-facing deployment.

## Automated Scan Results

| Tool | Result |
|------|--------|
| npm audit | **0 vulnerabilities** |
| ESLint security plugin | **0 errors, 36 warnings** (generic object injection sinks, no actionable issues) |
| Test suite | **240/240 tests passing** (153 vitest + 87 phase5) |

## Findings

### CRITICAL / HIGH Priority

#### 1. Missing OAuth State Parameter (CSRF) — HIGH
- **Location:** `server/routes/api-config.js` (OAuth callback handler)
- **Issue:** OAuth callback doesn't validate a CSRF state token. An attacker could trick a user into authorizing the attacker's account.
- **Fix:** Generate random state in `oauth-authorize-url`, store in session/settings, validate in callback.

#### 2. Redirect URI Derived from Request Header — HIGH
- **Location:** `server/routes/api-config.js` (OAuth flow)
- **Issue:** Redirect URI is built from `req.protocol` and `req.get('host')`, which can be spoofed via Host header injection.
- **Fix:** Use an environment variable (`OAUTH_REDIRECT_URI`) instead of request-derived values.

#### 3. Hardcoded Scrypt Salt — MEDIUM-HIGH
- **Location:** `server/crypto.js`
- **Issue:** Salt is a hardcoded constant (`punchpilot-salt-v2`). With a strong APP_SECRET this is acceptable, but weakens defense-in-depth.
- **Mitigating factors:** APP_SECRET must be strong (32 bytes), single-instance deployment, credentials don't leave container.

### MEDIUM Priority

| # | Issue | Location |
|---|-------|----------|
| 4 | Missing CSP header | `server/app.js` |
| 5 | In-memory rate limiter (no persistence across restarts) | `server/app.js` |
| 6 | No OAuth token revocation on logout | `server/auth.js` |
| 7 | K8s deployment missing securityContext | `k8s/03-deployment.yaml` |
| 8 | Username logged in plaintext | `server/routes/api-config.js` |
| 9 | Error messages expose internal details | Various route files |
| 10 | Log file permissions not hardened | `server/logger.js` |

### LOW Priority

| # | Issue |
|---|-------|
| 11 | Bearer token format not validated |
| 12 | SameSite cookie should be 'strict' in production |
| 13 | Docker base image not multi-stage optimized |
| 14 | K8s uses `latest` tag instead of pinned version |

## Positive Security Aspects

- AES-256-GCM encryption with unique IV per operation
- bcryptjs (cost 10) password hashing
- Crypto-secure session tokens (`crypto.randomUUID()`)
- All SQL queries use parameterized statements (no injection)
- Input validation with whitelists and regex throughout
- Non-root container execution (`ppuser`)
- Keystore volume isolated from data
- HSTS, X-Frame-Options: DENY, X-Content-Type-Options: nosniff
- Rate limiting on login (10 attempts / 15 min per IP)
- Session expiry with cleanup (24-hour duration)
- No external telemetry; data stays in user infrastructure

## Recommendations

1. **Before external deployment:** Fix OAuth state parameter and redirect URI issues
2. **Next release:** Add CSP header, implement token revocation on logout
3. **Ongoing:** Integrate npm audit into CI pipeline, add Dependabot auto-merge for patches
