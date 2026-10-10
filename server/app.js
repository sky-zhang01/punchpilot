import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authMiddleware } from './auth.js';
import authRoutes from './routes/api-auth.js';
import configRoutes from './routes/api-config.js';
import scheduleRoutes from './routes/api-schedule.js';
import logRoutes from './routes/api-logs.js';
import holidayRoutes from './routes/api-holidays.js';
import statusRoutes from './routes/api-status.js';
import attendanceRoutes from './routes/attendance/index.js';
import logger, { safeErrorMetadata } from './logger.js';
import { currentExecutionLogIdentityKey } from './db.js';
import {
  ensureScreenshotsDir,
  isGeneratedScreenshotFilename,
} from './automation/constants.js';
import {
  getRequestOrigin,
  normalizeOriginHeader,
  requestUsesSecureTransport,
  resolvePublicOrigin,
} from './public-origin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger.child('Express');

const app = express();

function configuredTrustProxy(value = process.env.TRUST_PROXY) {
  if (!value?.trim()) return false;
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  const namedRanges = new Set(['loopback', 'linklocal', 'uniquelocal']);
  const addressOrCidr = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Fa-f0-9:]+)(?:\/\d{1,3})?$/;
  if (
    entries.length === 0 ||
    entries.some((entry) => !namedRanges.has(entry) && !addressOrCidr.test(entry))
  ) {
    throw new Error('TRUST_PROXY must contain only named private ranges or IP/CIDR entries');
  }
  return entries;
}

// Proxy headers are ignored by default. Reverse-proxy deployments must name
// the actual trusted peer ranges so direct clients cannot spoof their IP or
// HTTPS state through X-Forwarded-* headers.
app.set('trust proxy', configuredTrustProxy());

// Hide framework identity
app.disable('x-powered-by');

// Security headers middleware
// NOTE: style-src requires 'unsafe-inline' because antd 6's @ant-design/cssinjs v2
// injects <style> tags at runtime without nonce support (StyleProvider has no nonce prop).
// script-src uses 'self' only (all JS is served as external files by Vite build).
// NOTE: COOP (Cross-Origin-Opener-Policy) is intentionally omitted because 'same-origin'
// severs the window.opener link between OAuth callback popups and the main window,
// breaking the postMessage-based auto-refresh flow (REQ-OAUTH-01). Clickjacking is
// already mitigated by X-Frame-Options: DENY and CSP frame-ancestors 'none'.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=(), payment=()');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (requestUsesSecureTransport(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Request logging middleware (API requests only, skip static files)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level](`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
  }
  next();
});

// Basic rate limiter for login endpoint (in-memory, per IP)
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // max 10 attempts per window
const RATE_LIMIT_MAX_ENTRIES = 4096;
let rateLimitChecks = 0;

function pruneLoginAttempts(now) {
  for (const [key, value] of loginAttempts) {
    if (now - value.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
  while (loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = loginAttempts.keys().next().value;
    if (oldestKey === undefined) break;
    loginAttempts.delete(oldestKey);
  }
}

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const rateKey = String(ip).slice(0, 128);
  const now = Date.now();
  rateLimitChecks += 1;
  if (rateLimitChecks % 128 === 0 || loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES) {
    pruneLoginAttempts(now);
  }
  let entry = loginAttempts.get(rateKey);

  if (entry && now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.delete(rateKey);
    entry = null;
  }

  if (entry) {
    if (entry.count >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((entry.firstAttempt + RATE_LIMIT_WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log.warn(`Rate limited login after ${entry.count} failed attempts`);
      return res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      });
    }
  }

  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      loginAttempts.delete(rateKey);
      return;
    }
    if (res.statusCode !== 401) return;

    const failedAt = Date.now();
    const current = loginAttempts.get(rateKey);
    if (!current || failedAt - current.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      if (loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES) {
        pruneLoginAttempts(failedAt);
      }
      loginAttempts.set(rateKey, { count: 1, firstAttempt: failedAt });
    } else {
      current.count += 1;
    }
  });

  next();
}

function sameOriginWriteGuard(req, res, next) {
  if (
    !req.path.startsWith('/api/') ||
    ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  ) {
    return next();
  }

  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }

  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (!origin && !fetchSite) {
    if (req.path === '/api/auth/login') return next();
    const hasExplicitToken = Boolean(
      req.get('x-session-token') ||
      /^Bearer\s+\S+$/i.test(req.get('authorization') || ''),
    );
    if (hasExplicitToken) return next();
    if (
      req.cookies?.session_token &&
      req.get('x-punchpilot-request') !== '1'
    ) {
      return res.status(403).json({ error: 'Cross-site request rejected' });
    }
    return next();
  }

  const browserOrigin = normalizeOriginHeader(origin);
  if (!browserOrigin) {
    return res.status(403).json({ error: 'Invalid request origin' });
  }

  let publicOrigin;
  try {
    publicOrigin = resolvePublicOrigin(req);
  } catch (error) {
    log.error('Canonical public origin configuration is invalid', {
      error: safeErrorMetadata(error),
    });
    return res.status(503).json({ error: 'Public origin configuration is invalid' });
  }
  const requestOrigin = getRequestOrigin(req);
  if (
    !publicOrigin ||
    !requestOrigin ||
    requestOrigin !== publicOrigin ||
    browserOrigin !== publicOrigin
  ) {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }
  if (req.get('x-punchpilot-request') !== '1') {
    return res.status(403).json({ error: 'Cross-site request rejected' });
  }
  next();
}

// Middleware
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(sameOriginWriteGuard);

// Request timeout — longer for attendance endpoints (Playwright may take minutes)
app.use('/api/', (req, res, next) => {
  const isLongRunning = req.path.startsWith('/attendance/');
  const timeout = isLongRunning ? 9 * 60 * 1000 : 30000; // 9 min vs 30s
  req.setTimeout(timeout, () => {
    log.error(`Request timeout (${timeout / 1000}s): ${req.method} ${req.path}`);
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Apply rate limiter to login endpoint before auth middleware
app.post('/api/auth/login', loginRateLimiter);

// Auth middleware (protects /api/* except auth endpoints)
app.use(authMiddleware);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/attendance', attendanceRoutes);

// Serve only generated PNG screenshots, without following links from the
// host-mounted diagnostics directory.
const screenshotsDir = path.resolve(
  process.env.SCREENSHOTS_DIR || path.resolve(__dirname, '..', 'screenshots'),
);
app.get('/screenshots/:filename', async (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const filename = req.params.filename;
  if (!isGeneratedScreenshotFilename(filename)) {
    return res.status(404).json({ error: 'Not found' });
  }

  let handle;
  try {
    const identityDirectory = ensureScreenshotsDir(
      screenshotsDir,
      currentExecutionLogIdentityKey(),
    );
    // The strict filename allowlist, canonical parent check, and O_NOFOLLOW bind this read.
    const filePath = path.resolve(identityDirectory, filename); // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal, javascript.express.security.audit.express-path-join-resolve-traversal.express-path-join-resolve-traversal
    if (path.dirname(filePath) !== identityDirectory) {
      return res.status(404).json({ error: 'Not found' });
    }
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      await handle.close();
      handle = null;
      return res.status(404).json({ error: 'Not found' });
    }
    res.type('png');
    const stream = handle.createReadStream({ autoClose: true });
    handle = null;
    stream.on('error', next);
    stream.pipe(res);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (['ENOENT', 'ELOOP', 'EACCES'].includes(error?.code)) {
      return res.status(404).json({ error: 'Not found' });
    }
    next(error);
  }
});

// Serve React SPA (built files)
const clientDist = path.resolve(__dirname, '..', 'client', 'dist');

// Hashed assets (JS/CSS) — long-term cache (Vite content-hash in filenames)
app.use('/assets', express.static(path.join(clientDist, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));

// Other static files (favicon, images) — short-term cache
app.use(express.static(clientDist, {
  maxAge: '1d',
  index: false,
}));

// SPA fallback — index.html must not be cached (entry point for all client routes)
app.get('/{*splat}', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/screenshots/')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(clientDist, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Error handler - catch all Express errors
app.use((err, req, res, next) => {
  log.error(`Unhandled route error: ${req.method} ${req.path}`, {
    error: safeErrorMetadata(err),
  });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
