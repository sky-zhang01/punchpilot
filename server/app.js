import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { authMiddleware } from './auth.js';
import authRoutes from './routes/api-auth.js';
import configRoutes from './routes/api-config.js';
import scheduleRoutes from './routes/api-schedule.js';
import logRoutes from './routes/api-logs.js';
import holidayRoutes from './routes/api-holidays.js';
import statusRoutes from './routes/api-status.js';
import attendanceRoutes from './routes/api-attendance.js';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = logger.child('Express');

const app = express();

// Trust reverse proxy headers (X-Forwarded-For, X-Forwarded-Proto, etc.)
// Required for correct req.protocol behind NPM / Cloudflare / any reverse proxy
app.set('trust proxy', 1);

// Hide framework identity
app.disable('x-powered-by');

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'");
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.protocol === 'https') {
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

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry) {
    // Reset window if expired
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.set(ip, { count: 1, firstAttempt: now });
      return next();
    }
    if (entry.count >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((entry.firstAttempt + RATE_LIMIT_WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log.warn(`Rate limited login from ${ip} (${entry.count} attempts)`);
      return res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`,
      });
    }
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  }

  // Periodically clean stale entries
  if (Math.random() < 0.01) {
    for (const [key, val] of loginAttempts) {
      if (now - val.firstAttempt > RATE_LIMIT_WINDOW_MS) {
        loginAttempts.delete(key);
      }
    }
  }

  next();
}

// Middleware
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Request timeout — longer for attendance endpoints (Playwright may take minutes)
app.use('/api/', (req, res, next) => {
  const isLongRunning = req.path.startsWith('/attendance/');
  const timeout = isLongRunning ? 5 * 60 * 1000 : 30000; // 5 min vs 30s
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

// Serve screenshots (behind auth middleware)
const screenshotsDir = process.env.SCREENSHOTS_DIR || path.resolve(__dirname, '..', 'screenshots');
app.use('/screenshots', express.static(screenshotsDir));

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

// SPA fallback - serve index.html for all non-API routes (no cache)
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
    error: err.message,
    stack: err.stack,
  });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
