import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  createSession,
  getSession,
  deleteSession,
  deleteAllUserSessions,
  cleanExpiredSessions,
  clearInitialAdminPassword,
  getUserByUsername,
  getUserById,
  updateUser,
} from './db.js';
import { requestUsesSecureTransport } from './public-origin.js';

const SESSION_DURATION_HOURS = 24;
const BCRYPT_MAX_PASSWORD_BYTES = 72;
const LOGIN_PASSWORD_MAX_BYTES = 1024;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  `invalid-login-${crypto.randomBytes(32).toString('hex')}`,
  10,
);

function sessionCookieOptions(req) {
  return {
    httpOnly: true,
    maxAge: SESSION_DURATION_HOURS * 3600 * 1000,
    sameSite: 'lax',
    secure: requestUsesSecureTransport(req),
    path: '/',
  };
}

/**
 * Extract session token from request (cookie, header, or bearer)
 */
function extractToken(req) {
  return (
    req.cookies?.session_token ||
    req.headers['x-session-token'] ||
    req.headers.authorization?.replace('Bearer ', '')
  );
}

/**
 * Auth middleware - protects /api/* routes (except login/status/password)
 * Attaches req.userId and req.user for downstream handlers.
 */
export function authMiddleware(req, res, next) {
  // Allow auth endpoints without token
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/status' ||
    req.path === '/api/config/oauth-callback'
  ) {
    return next();
  }

  // Allow non-API routes except persisted browser artifacts.
  const protectedArtifact =
    req.path === '/screenshots' || req.path.startsWith('/screenshots/');
  if (!req.path.startsWith('/api/') && !protectedArtifact) {
    return next();
  }

  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = getSession(token);
  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) deleteSession(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  if (!session.user_id) {
    deleteSession(token);
    return res.status(401).json({ error: 'Invalid session' });
  }

  const user = getUserById(session.user_id);
  if (!user) {
    deleteSession(token);
    return res.status(401).json({ error: 'Invalid session' });
  }

  req.userId = user.id;
  req.user = {
    id: user.id,
    username: user.username,
    must_change_password: !!user.must_change_password,
  };

  // Enforce password change — only allow auth endpoints until password is changed
  if (user.must_change_password && !req.path.startsWith('/api/auth/')) {
    return res.status(403).json({ error: 'Password change required', must_change_password: true });
  }

  next();
}

/**
 * Handle login request - username + password with bcrypt verification
 */
export function loginHandler(req, res) {
  const { username, password } = req.body || {};

  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !username ||
    !password ||
    username.length > 50 ||
    Buffer.byteLength(password, 'utf8') > LOGIN_PASSWORD_MAX_BYTES
  ) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = getUserByUsername(username);
  const passwordMatches = bcrypt.compareSync(
    password,
    user?.password_hash || DUMMY_PASSWORD_HASH,
  );
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: 'Invalid username or password', failed: true });
  }

  // Block login with 'admin' username if the user has already changed their credentials
  // (must_change_password=0 means they already completed the forced change)
  if (username.toLowerCase() === 'admin' && !user.must_change_password) {
    return res.status(403).json({
      error: 'The default admin account has been disabled. Please use your configured username.',
    });
  }

  cleanExpiredSessions();

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000
  ).toISOString();

  createSession(token, user.id, expiresAt);

  res.cookie('session_token', token, sessionCookieOptions(req));

  res.json({
    username: user.username,
    must_change_password: !!user.must_change_password,
  });
}

/**
 * Handle password (and username) change - required on first login
 */
export function changePasswordHandler(req, res) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = getSession(token);
  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) deleteSession(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  if (!session.user_id) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const user = getUserById(session.user_id);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  const { old_password, new_username, new_password } = req.body || {};

  if (
    typeof new_password !== 'string' ||
    (new_username !== undefined && typeof new_username !== 'string') ||
    (old_password !== undefined && typeof old_password !== 'string')
  ) {
    return res.status(400).json({ error: 'Invalid password change request' });
  }

  const isInitialPasswordChange = !!user.must_change_password;

  // For first-login (must_change_password=1), skip old password verification
  // For regular password changes, old password is required
  if (!user.must_change_password) {
    if (!old_password || !bcrypt.compareSync(old_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }

  // Validate new password - must be 8+ chars with uppercase, lowercase, and number
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (Buffer.byteLength(new_password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    return res.status(400).json({ error: 'Password must be at most 72 UTF-8 bytes' });
  }
  if (!/[A-Z]/.test(new_password)) {
    return res.status(400).json({ error: 'Password must contain at least one uppercase letter' });
  }
  if (!/[a-z]/.test(new_password)) {
    return res.status(400).json({ error: 'Password must contain at least one lowercase letter' });
  }
  if (!/[0-9]/.test(new_password)) {
    return res.status(400).json({ error: 'Password must contain at least one number' });
  }

  // Validate new username
  const finalUsername = new_username?.trim() || user.username;

  if (finalUsername.toLowerCase() === 'admin') {
    return res.status(400).json({ error: 'Username "admin" is not allowed. Please choose a different username.' });
  }

  if (finalUsername.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }

  if (finalUsername.length > 50) {
    return res.status(400).json({ error: 'Username must be 50 characters or less' });
  }
  if (/\p{Cc}/u.test(finalUsername)) {
    return res.status(400).json({ error: 'Username contains invalid control characters' });
  }

  // Check if new username is taken by another user
  const existing = getUserByUsername(finalUsername);
  if (existing && existing.id !== user.id) {
    return res.status(409).json({ error: 'Username is already taken' });
  }

  // Update user
  const newHash = bcrypt.hashSync(new_password, 10);
  updateUser(user.id, {
    username: finalUsername,
    password_hash: newHash,
    must_change_password: 0,
  });
  if (isInitialPasswordChange) clearInitialAdminPassword();

  // Clear all existing sessions for this user (security: force re-login with new creds)
  deleteAllUserSessions(user.id);

  // Create a new session so the user stays logged in
  const newToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000
  ).toISOString();

  createSession(newToken, user.id, expiresAt);

  res.cookie('session_token', newToken, sessionCookieOptions(req));

  res.json({
    success: true,
    username: finalUsername,
    must_change_password: false,
  });
}

/**
 * Handle logout request
 */
export function logoutHandler(req, res) {
  const token = extractToken(req);

  if (token) {
    deleteSession(token);
  }

  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true });
}

/**
 * Check auth status - returns user info if authenticated
 */
export function statusHandler(req, res) {
  const token = extractToken(req);

  if (!token) {
    return res.json({ authenticated: false });
  }

  const session = getSession(token);
  if (!session || new Date(session.expires_at) < new Date()) {
    if (session) deleteSession(token);
    return res.json({ authenticated: false });
  }

  if (!session.user_id) {
    deleteSession(token);
    return res.json({ authenticated: false });
  }

  const user = getUserById(session.user_id);
  if (!user) {
    deleteSession(token);
    return res.json({ authenticated: false });
  }

  const result = {
    authenticated: true,
    expires_at: session.expires_at,
    username: user.username,
    must_change_password: !!user.must_change_password,
  };

  res.json(result);
}
