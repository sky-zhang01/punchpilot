/**
 * API Integration Tests (Supertest)
 *
 * Tests the Express app's HTTP layer:
 *   - Auth flow: login, session, logout, password change
 *   - Security headers
 *   - Rate limiting
 *   - Config endpoints (CRUD)
 *   - Auth protection (401 for unauthenticated)
 *   - Input validation
 *
 * Note: The app uses an in-memory rate limiter (10 attempts / 15 min per
 *       verified client IP).
 *       We login once at suite level and reuse the token to avoid hitting the limit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createSession, deleteSession, initDatabase, getDb, getSession } from '../server/db.js';

// Initialize database before importing app (app.js imports modules that need DB)
initDatabase();

const { default: app } = await import('../server/app.js');

// Test credentials (not 'admin' to avoid the admin-username-block when must_change_password=0)
const DEFAULT_USER = 'testadmin';
const DEFAULT_PASS = 'TestPass123';

// Suite-level session token (login once, reuse everywhere)
let SESSION_TOKEN;

/** Extract session_token from set-cookie header */
function extractTokenFromCookies(res) {
  const cookies = res.headers['set-cookie'];
  const raw = Array.isArray(cookies)
    ? cookies.find(c => c.startsWith('session_token='))
    : (cookies && cookies.startsWith('session_token=') ? cookies : undefined);
  if (!raw) return undefined;
  return raw.split(';')[0].replace('session_token=', '');
}

beforeAll(async () => {
  // Reset test user to known state
  const db = getDb();
  const hash = bcrypt.hashSync(DEFAULT_PASS, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_USER);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hash, existing.id);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 0)')
      .run(DEFAULT_USER, hash);
  }

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
  SESSION_TOKEN = extractTokenFromCookies(res);
});

describe('Security Headers', () => {
  it('returns X-Content-Type-Options: nosniff', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns X-Frame-Options: DENY', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('returns Content-Security-Policy header', async () => {
    const res = await request(app).get('/api/auth/status');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // style-src requires 'unsafe-inline' because antd 6's @ant-design/cssinjs v2
    // injects <style> tags at runtime without nonce support
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('keeps the OAuth callback CSP-compatible without inline executable data', async () => {
    const marker = 'oauth-sensitive-marker';
    const injected = `${marker}<img src=x onerror=alert(1)>`;
    const res = await request(app)
      .get('/api/config/oauth-callback')
      .query({ error: injected });

    expect(res.status).toBe(200);
    expect(res.text).toContain('src="/oauth-callback.js"');
    expect(res.text).not.toContain(injected);
    expect(res.text).not.toContain(marker);
    expect(res.text).not.toContain('postMessage(');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('returns Referrer-Policy', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('UT-SEC-08: CSP includes form-action self', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
  });

  it('UT-SEC-09: CSP includes base-uri self', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['content-security-policy']).toContain("base-uri 'self'");
  });

  it('UT-SEC-10: returns Permissions-Policy header', async () => {
    const res = await request(app).get('/api/auth/status');
    const pp = res.headers['permissions-policy'];
    expect(pp).toBeDefined();
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('camera=()');
  });

  // COOP (Cross-Origin-Opener-Policy) is intentionally omitted — 'same-origin' severs
  // window.opener between OAuth callback popups and the main window, breaking postMessage
  // auto-refresh (REQ-OAUTH-01). Clickjacking is mitigated by X-Frame-Options + CSP.
  it('UT-SEC-11: does NOT set Cross-Origin-Opener-Policy (OAuth popup compatibility)', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
  });

  it('UT-SEC-12: returns Cross-Origin-Resource-Policy: same-origin', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('UT-SEC-14: returns Cross-Origin-Embedder-Policy: credentialless', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.headers['cross-origin-embedder-policy']).toBe('credentialless');
  });
});

describe('Cross-site write protection', () => {
  it('rejects browser write requests marked as cross-site', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    expect(res.status).toBe(403);
  });

  it('rejects a mismatched Origin on state-changing requests', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://cross-site.example.invalid')
      .set('Host', 'punchpilot.example.invalid')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    expect(res.status).toBe(403);
  });

  it('rejects a same-host Origin with a different scheme', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://punchpilot.example.invalid')
      .set('Host', 'punchpilot.example.invalid')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    expect(res.status).toBe(403);
  });

  it('allows same-origin and non-browser API clients', async () => {
    const previousOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    let sameOrigin;
    try {
      sameOrigin = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'https://punchpilot.example.invalid')
        .set('Host', 'punchpilot.example.invalid')
        .set('X-Forwarded-Proto', 'https')
        .set('X-PunchPilot-Request', '1')
        .send({});
    } finally {
      if (previousOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
      else process.env.PUNCHPILOT_PUBLIC_ORIGIN = previousOrigin;
    }
    const noOrigin = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(sameOrigin.status).toBe(400);
    expect(noOrigin.status).toBe(400);
  });

  it('requires the application marker for cookie-authenticated writes without metadata', async () => {
    const blocked = await request(app)
      .put('/api/config/oauth-select-company')
      .set('Cookie', [`session_token=${SESSION_TOKEN}`])
      .send({});
    const marked = await request(app)
      .put('/api/config/oauth-select-company')
      .set('Cookie', [`session_token=${SESSION_TOKEN}`])
      .set('X-PunchPilot-Request', '1')
      .send({});
    const explicitToken = await request(app)
      .put('/api/config/oauth-select-company')
      .set('X-Session-Token', SESSION_TOKEN)
      .send({});

    expect(blocked.status).toBe(403);
    expect(marked.status).toBe(400);
    expect(explicitToken.status).toBe(400);
  });

  it('rejects a Host and Origin that agree with each other but not the canonical origin', async () => {
    const previousOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'https://host-injection.example.invalid')
        .set('Host', 'host-injection.example.invalid')
        .set('X-Forwarded-Proto', 'https')
        .set('X-PunchPilot-Request', '1')
        .send({ username: DEFAULT_USER, password: DEFAULT_PASS });

      expect(res.status).toBe(403);
    } finally {
      if (previousOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
      else process.env.PUNCHPILOT_PUBLIC_ORIGIN = previousOrigin;
    }
  });

  it('allows zero-configuration browser writes only on loopback', async () => {
    const previousOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    const previousRedirect = process.env.OAUTH_REDIRECT_URI;
    delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    delete process.env.OAUTH_REDIRECT_URI;
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://127.0.0.1')
        .set('Host', '127.0.0.1')
        .set('X-PunchPilot-Request', '1')
        .send({});

      expect(res.status).toBe(400);
    } finally {
      if (previousOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
      else process.env.PUNCHPILOT_PUBLIC_ORIGIN = previousOrigin;
      if (previousRedirect === undefined) delete process.env.OAUTH_REDIRECT_URI;
      else process.env.OAUTH_REDIRECT_URI = previousRedirect;
    }
  });

  it('rejects a browser write without the application request marker', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://punchpilot.example.invalid')
      .set('Host', 'punchpilot.example.invalid')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });

    expect(res.status).toBe(403);
  });
});

describe('HSTS Header', () => {
  it('UT-SEC-05: no HSTS on plain HTTP request', async () => {
    const res = await request(app).get('/api/auth/status');
    // Supertest defaults to HTTP, so no HSTS should be set
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('UT-SEC-06: HSTS sent when X-Forwarded-Proto is https', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('X-Forwarded-Proto', 'https');
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBeDefined();
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sends HSTS from the canonical HTTPS origin without forwarded-protocol headers', async () => {
    const previousOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    try {
      const res = await request(app).get('/api/auth/status');
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    } finally {
      if (previousOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
      else process.env.PUNCHPILOT_PUBLIC_ORIGIN = previousOrigin;
    }
  });
});

describe('Cookie Secure Flag (v0.4.2)', () => {
  it('UT-TP-06: HTTP login → cookie WITHOUT Secure flag', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    if (res.status === 429) return; // Skip if rate-limited
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'];
    const sessionCookie = Array.isArray(cookies)
      ? cookies.find(c => c.startsWith('session_token='))
      : cookies;
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.toLowerCase()).not.toContain('; secure');
  });

  it('UT-TP-07: HTTPS (X-Forwarded-Proto) login → cookie WITH Secure flag', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    if (res.status === 429) return; // Skip if rate-limited
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookies)
      ? cookies.find(c => c.startsWith('session_token='))
      : cookies;
    expect(cookieHeader).toBeDefined();
    expect(cookieHeader).toContain('Secure');
  });

  it('uses a Secure cookie for the canonical HTTPS origin without forwarded-protocol headers', async () => {
    const previousOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
      expect(res.status).toBe(200);
      const cookies = res.headers['set-cookie'];
      const cookieHeader = Array.isArray(cookies)
        ? cookies.find(c => c.startsWith('session_token='))
        : cookies;
      expect(cookieHeader).toContain('Secure');
    } finally {
      if (previousOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
      else process.env.PUNCHPILOT_PUBLIC_ORIGIN = previousOrigin;
    }
  });
});

describe('Auth: Login', () => {
  it('POST /api/auth/login with valid credentials → 200 + cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined(); // token must NOT leak in response body
    expect(extractTokenFromCookies(res)).toBeDefined(); // token is in httpOnly cookie
    expect(res.body.username).toBe(DEFAULT_USER);
    expect(res.body.must_change_password).toBe(false); // test user has already changed password
  });

  it('POST /api/auth/login with wrong password → 401 + failed flag', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: DEFAULT_USER, password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.failed).toBe(true);
  });

  it('POST /api/auth/login with unknown user → 401 + failed flag', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent', password: 'anypassword' });
    expect(res.status).toBe(401);
    expect(res.body.failed).toBe(true);
  });

  it('POST /api/auth/login without body → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
  });

  it('sets httpOnly session_token cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const sessionCookie = Array.isArray(cookies)
      ? cookies.find(c => c.startsWith('session_token='))
      : cookies.startsWith('session_token=') ? cookies : undefined;
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Path=/');
  });

  it('rejects non-string login fields without throwing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: { value: DEFAULT_USER }, password: [DEFAULT_PASS] });
    expect(res.status).toBe(400);
  });

  it('stores only a one-way hash of the bearer token in SQLite', () => {
    const session = getSession(SESSION_TOKEN);
    expect(session).toBeDefined();
    expect(session.id).not.toBe(SESSION_TOKEN);
    expect(session.id).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('migrates a legacy plaintext session token on first successful lookup', () => {
    const legacyToken = 'synthetic-legacy-token';
    const user = getDb().prepare('SELECT id FROM users WHERE username = ?').get(DEFAULT_USER);
    getDb()
      .prepare('INSERT OR REPLACE INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(legacyToken, user.id, new Date(Date.now() + 60_000).toISOString());

    const session = getSession(legacyToken);
    expect(session.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get(legacyToken)).toBeUndefined();
    deleteSession(legacyToken);
  });
});

describe('Auth: Status', () => {
  it('GET /api/auth/status without token → { authenticated: false }', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it('GET /api/auth/status with valid token → { authenticated: true }', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.username).toBe(DEFAULT_USER);
  });

  it('GET /api/auth/status with invalid token → { authenticated: false }', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('x-session-token', 'invalid-token-12345');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });

  it('rejects a legacy session that is not bound to a user', async () => {
    const token = ['synthetic', 'unbound', 'session', 'token'].join('-');
    createSession(token, null, new Date(Date.now() + 60_000).toISOString());

    const protectedRes = await request(app)
      .get('/api/config')
      .set('x-session-token', token);
    const statusRes = await request(app)
      .get('/api/auth/status')
      .set('x-session-token', token);

    expect(protectedRes.status).toBe(401);
    expect(statusRes.body.authenticated).toBe(false);
    expect(getSession(token)).toBeUndefined();
  });
});

describe('Auth: Logout', () => {
  it('POST /api/auth/logout invalidates session', async () => {
    // Create a dedicated session for this test
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
    const tempToken = extractTokenFromCookies(loginRes);

    // Logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('x-session-token', tempToken);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Verify session is invalid after logout
    const statusRes = await request(app)
      .get('/api/auth/status')
      .set('x-session-token', tempToken);
    expect(statusRes.body.authenticated).toBe(false);
  });
});

describe('Auth: Password Change', () => {
  it('PUT /api/auth/password requires authentication', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .send({ new_username: 'newuser', new_password: 'NewPass123' });
    expect(res.status).toBe(401);
  });

  it('PUT /api/auth/password validates password complexity (min 8 chars)', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('x-session-token', SESSION_TOKEN)
      .send({ old_password: DEFAULT_PASS, new_password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('PUT /api/auth/password rejects passwords without uppercase', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('x-session-token', SESSION_TOKEN)
      .send({ old_password: DEFAULT_PASS, new_password: 'lowercase123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('uppercase');
  });

  it('PUT /api/auth/password rejects passwords without number', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('x-session-token', SESSION_TOKEN)
      .send({ old_password: DEFAULT_PASS, new_password: 'NoNumberHere' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('number');
  });

  it('PUT /api/auth/password rejects "admin" as username', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('x-session-token', SESSION_TOKEN)
      .send({ old_password: DEFAULT_PASS, new_username: 'admin', new_password: 'ValidPass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('admin');
  });

  it('PUT /api/auth/password rejects values beyond bcrypt input capacity', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('x-session-token', SESSION_TOKEN)
      .send({ old_password: DEFAULT_PASS, new_password: `Valid1${'x'.repeat(67)}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('72 UTF-8 bytes');
  });
});

describe('Auth Protection: Protected endpoints return 401', () => {
  it('screenshot artifacts require authentication', async () => {
    const res = await request(app).get('/screenshots/nonexistent.png');
    expect(res.status).toBe(401);
  });

  const protectedEndpoints = [
    ['GET', '/api/config'],
    ['GET', '/api/config/account'],
    ['GET', '/api/schedule'],
    ['GET', '/api/status'],
    ['GET', '/api/logs'],
    ['GET', '/api/holidays'],
    ['GET', '/api/attendance/today'],
  ];

  for (const [method, path] of protectedEndpoints) {
    it(`${method} ${path} → 401 without token`, async () => {
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).toBe(401);
    });
  }
});

describe('Config Endpoints (authenticated)', () => {
  it('GET /api/config returns configuration', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('auto_checkin_enabled');
    expect(res.body).toHaveProperty('connection_mode');
  });

  it('GET /api/config/account returns account info', async () => {
    const res = await request(app)
      .get('/api/config/account')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('freee_configured');
    expect(res.body).toHaveProperty('freee_username');
    expect(res.body).toHaveProperty('freee_company_name');
    // Password must NOT be returned
    expect(res.body.password).toBeUndefined();
    expect(res.body.freee_password).toBeUndefined();
  });

  it('PUT /api/config/account stores encrypted credentials', async () => {
    const res = await request(app)
      .put('/api/config/account')
      .set('x-session-token', SESSION_TOKEN)
      .send({
        username: 'testuser@example.com',
        password: 'testpassword123',
        company_name: 'Example Company',
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify GET returns saved username
    const getRes = await request(app)
      .get('/api/config/account')
      .set('x-session-token', SESSION_TOKEN);
    expect(getRes.body.freee_username).toBe('testuser@example.com');
    expect(getRes.body.freee_configured).toBe(true);
    expect(getRes.body.freee_company_name).toBe('Example Company');
    // Password must NOT be returned
    expect(getRes.body.password).toBeUndefined();
  });

  it('DELETE /api/config/account clears credentials', async () => {
    const res = await request(app)
      .delete('/api/config/account')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify cleared
    const getRes = await request(app)
      .get('/api/config/account')
      .set('x-session-token', SESSION_TOKEN);
    expect(getRes.body.freee_username).toBeFalsy();
    expect(getRes.body.freee_configured).toBe(false);
  });
});

describe('Schedule Endpoints (authenticated)', () => {
  it('GET /api/schedule returns today schedule', async () => {
    const res = await request(app)
      .get('/api/schedule')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('date');
    expect(res.body).toHaveProperty('schedule');
  });
});

describe('Logs Endpoint (authenticated)', () => {
  it('GET /api/logs returns paginated log data', async () => {
    const res = await request(app)
      .get('/api/logs')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(200);
    // Paginated response — has rows array and pagination metadata
    expect(res.body).toHaveProperty('rows');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body).toHaveProperty('total');
  });

  it('rejects unbounded or malformed pagination values', async () => {
    const negative = await request(app)
      .get('/api/logs?limit=-1')
      .set('x-session-token', SESSION_TOKEN);
    const oversized = await request(app)
      .get('/api/logs?limit=101')
      .set('x-session-token', SESSION_TOKEN);
    const malformed = await request(app)
      .get('/api/logs?page=not-a-number')
      .set('x-session-token', SESSION_TOKEN);

    expect(negative.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(malformed.status).toBe(400);
  });
});

describe('Rate Limiting', () => {
  it('does not count successful logins against the failed-attempt budget', async () => {
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.42')
        .send({ username: DEFAULT_USER, password: DEFAULT_PASS });
      expect(res.status).toBe(200);
    }
  });

  it('rate limiter returns 429 after excessive attempts', async () => {
    const blockedIp = '198.51.100.88';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', blockedIp)
        .send({ username: DEFAULT_USER, password: 'wrong-password' });
      expect(failed.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', blockedIp)
      .send({ username: DEFAULT_USER, password: 'wrong-password' });
    const independent = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '198.51.100.89')
      .send({ username: DEFAULT_USER, password: DEFAULT_PASS });

    expect(blocked.status).toBe(429);
    expect(independent.status).toBe(200);
  });

  it('does not let one IP reset its budget by rotating usernames', async () => {
    const blockedIp = '198.51.100.90';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', blockedIp)
        .send({
          username: `unknown-user-${attempt}`,
          password: 'wrong-password',
        });
      expect(failed.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', blockedIp)
      .send({ username: 'one-more-user', password: 'wrong-password' });

    expect(blocked.status).toBe(429);
  });
});

describe('Input Validation / XSS Protection', () => {
  it('login: XSS in username is treated as literal string, not executed', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '<script>alert(1)</script>', password: 'password' });
    // Should fail auth (401) or hit rate limit (429), NOT cause 500
    expect([401, 429]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  it('JSON content type is enforced for API endpoints', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'text/plain')
      .send('not json');
    // Express will fail to parse or treat as empty body → 400 or rate-limited 429
    expect([400, 429]).toContain(res.status);
  });

  it('batch withdrawal rejects non-numeric request IDs before background processing', async () => {
    const res = await request(app)
      .post('/api/attendance/batch-withdraw')
      .set('x-session-token', SESSION_TOKEN)
      .send({ requests: [{ id: '../unexpected', type: 'WorkTime' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('positive integer');
    expect(res.body.task_id).toBeUndefined();
  });
});

describe('404 for unknown API routes', () => {
  it('GET /api/nonexistent → 401 (auth required) or 404', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect([401, 404]).toContain(res.status);
  });

  it('authenticated GET /api/nonexistent → 404', async () => {
    const res = await request(app)
      .get('/api/nonexistent')
      .set('x-session-token', SESSION_TOKEN);
    expect(res.status).toBe(404);
  });
});
