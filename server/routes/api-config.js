import { Router } from 'express';
import crypto from 'crypto';
import { getAllConfig, getConfigByAction, updateConfig, getSetting, setSetting } from '../db.js';
import { scheduler } from '../scheduler.js';
import { encrypt, decrypt } from '../crypto.js';
import { FreeeApiClient } from '../freee-api.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const VALID_ACTIONS = ['checkin', 'checkout', 'break_start', 'break_end'];
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Shared verify function: attempt login to freee with given credentials.
 * Returns { valid: boolean, error?: string }
 */
async function verifyFreeeLogin(username, password) {
  const { chromium } = await import('playwright');

  const masked = username.replace(/(.{3}).*(@.*)/, '$1***$2');
  console.log(`[Verify] Attempting freee login for user: ${masked}`);

  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, slowMo: 50 });
    const page = await browser.newPage();

    const loginUrl = 'https://p.secure.freee.co.jp/';
    console.log(`[Verify] Navigating to ${loginUrl}`);
    await page.goto(loginUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Fill login form
    await page.fill("input[name='loginId']", username);
    await page.fill("input[name='password']", password);

    // Capture URL before submit
    const preSubmitUrl = page.url();
    await page.click("button[type='submit']");

    // Wait for navigation after submit
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await page.waitForTimeout(4000);
    } catch { /* timeout ok */ }

    const postSubmitUrl = page.url();
    console.log(`[Verify] Pre: ${preSubmitUrl} -> Post: ${postSubmitUrl}`);

    // Debug screenshot
    const screenshotsDir = process.env.SCREENSHOTS_DIR || path.resolve(__dirname, '..', '..', 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    const ssPath = path.join(screenshotsDir, `verify-${Date.now()}.png`);
    await page.screenshot({ path: ssPath }).catch(() => {});
    console.log(`[Verify] Screenshot saved: ${ssPath}`);

    const pageTitle = await page.title().catch(() => '');
    console.log(`[Verify] Page title: ${pageTitle}`);

    const urlChanged = postSubmitUrl !== preSubmitUrl;
    const hasAttendanceUI = await page.$('[data-testid="出勤"], [data-testid="退勤"], [data-testid="休憩開始"], [data-testid="休憩終了"]');
    const loginForm = await page.$("input[name='loginId']");
    const hasLoginSpecificError = await page.$('.login-form__error, .error-message-text, [data-testid="login-error"]');

    console.log(`[Verify] urlChanged=${urlChanged}, hasAttendanceUI=${!!hasAttendanceUI}, loginForm=${!!loginForm}, hasError=${!!hasLoginSpecificError}`);

    if (hasAttendanceUI) {
      console.log('[Verify] Success: attendance UI detected');
      return { valid: true };
    }
    if (urlChanged && !loginForm) {
      console.log('[Verify] Success: navigated away from login page');
      return { valid: true };
    }
    if (hasLoginSpecificError || (!urlChanged && loginForm)) {
      console.log('[Verify] Failed: still on login page or error detected');
      return { valid: false, error: 'Login failed - please check your credentials' };
    }
    if (urlChanged) {
      console.log('[Verify] Likely success: URL changed');
      return { valid: true };
    }

    return { valid: false, error: 'Could not determine login result' };
  } catch (e) {
    console.error('[Verify] Credential verification failed:', e.message);
    return { valid: false, error: e.message || 'Connection failed' };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Resolve current freee credentials (GUI > env).
 * Returns { username, password } or null if none configured.
 */
function resolveCredentials() {
  const freeeConfigured = getSetting('freee_configured') === '1';
  const freeeUsernameEnc = getSetting('freee_username_encrypted') || '';
  const freeePasswordEnc = getSetting('freee_password_encrypted') || '';

  if (freeeConfigured && freeeUsernameEnc && freeePasswordEnc) {
    const username = decrypt(freeeUsernameEnc);
    const password = decrypt(freeePasswordEnc);
    if (username && password) return { username, password };
  }
  if (process.env.LOGIN_USERNAME && process.env.LOGIN_PASSWORD) {
    return { username: process.env.LOGIN_USERNAME, password: process.env.LOGIN_PASSWORD };
  }
  return null;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * GET /api/config - Get all schedule configurations + system info
 */
router.get('/', (req, res) => {
  const configs = getAllConfig();
  const autoEnabled = getSetting('auto_checkin_enabled') === '1';
  const debugMode = getSetting('debug_mode') === '1';
  const freeeConfigured = getSetting('freee_configured') === '1';
  const freeeUsername = decrypt(getSetting('freee_username_encrypted') || '') || '';
  const connectionMode = getSetting('connection_mode') || 'api';
  const oauthConfigured = getSetting('oauth_configured') === '1';
  const oauthCompanyId = getSetting('oauth_company_id') || '';
  const holidaySkipCountries = getSetting('holiday_skip_countries') || 'jp';

  res.json({
    auto_checkin_enabled: autoEnabled,
    debug_mode: debugMode,
    freee_configured: freeeConfigured,
    freee_username: freeeUsername,
    connection_mode: connectionMode,
    oauth_configured: oauthConfigured,
    oauth_company_id: oauthCompanyId,
    holiday_skip_countries: holidaySkipCountries,
    schedules: configs,
  });
});

/**
 * PUT /api/config/toggle - Toggle master auto check-in switch
 */
router.put('/toggle', async (req, res) => {
  const current = getSetting('auto_checkin_enabled');
  const newValue = current === '1' ? '0' : '1';
  setSetting('auto_checkin_enabled', newValue);

  // Re-initialize scheduler
  await scheduler.initialize();

  res.json({ auto_checkin_enabled: newValue === '1' });
});

/**
 * PUT /api/config/holiday-skip-countries - Set which countries' holidays to skip for auto-punch
 * Body: { countries: "jp" | "cn" | "jp,cn" }
 */
router.put('/holiday-skip-countries', (req, res) => {
  const { countries } = req.body;
  if (!countries || typeof countries !== 'string') {
    return res.status(400).json({ error: 'countries is required (comma-separated: jp,cn)' });
  }
  const valid = countries.split(',').every(c => ['jp', 'cn'].includes(c.trim()));
  if (!valid) {
    return res.status(400).json({ error: 'Invalid country code. Supported: jp, cn' });
  }
  setSetting('holiday_skip_countries', countries);
  res.json({ holiday_skip_countries: countries });
});

/**
 * PUT /api/config/debug - Toggle debug/mock mode
 */
router.put('/debug', (req, res) => {
  const current = getSetting('debug_mode');
  const newValue = current === '1' ? '0' : '1';
  setSetting('debug_mode', newValue);
  res.json({ debug_mode: newValue === '1' });
});

/**
 * PUT /api/config/debug/set - Set debug mode explicitly
 */
router.put('/debug/set', (req, res) => {
  const { enabled } = req.body;
  const val = enabled ? '1' : '0';
  setSetting('debug_mode', val);
  res.json({ debug_mode: val === '1' });
});

/**
 * GET /api/config/account - Get freee account configuration status
 */
router.get('/account', (req, res) => {
  const freeeConfigured = getSetting('freee_configured') === '1';
  const freeeUsername = decrypt(getSetting('freee_username_encrypted') || '') || '';
  const hasEnvCreds = !!(process.env.LOGIN_USERNAME && process.env.LOGIN_PASSWORD);

  res.json({
    freee_configured: freeeConfigured,
    freee_username: freeeUsername,
    has_env_credentials: hasEnvCreds,
    env_username: process.env.LOGIN_USERNAME
      ? process.env.LOGIN_USERNAME.replace(/(.{3}).*(@.*)/, '$1***$2')
      : '',
  });
});

/**
 * PUT /api/config/account - Save freee account credentials (encrypted)
 * Save only — no auto-verify. Verification is a separate action via POST /verify-credentials.
 */
router.put('/account', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Encrypt and store
    setSetting('freee_username_encrypted', encrypt(username));
    setSetting('freee_password_encrypted', encrypt(password));
    setSetting('freee_username', ''); // clear legacy plaintext
    setSetting('freee_configured', '1');

    const masked = username.replace(/(.{3}).*(@.*)/, '$1***$2');
    console.log(`[Config] Credentials saved for user: ${masked}`);

    res.json({
      success: true,
      freee_configured: true,
      freee_username: username,
    });
  } catch (err) {
    console.error('[Config] Error saving account:', err.message);
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

/**
 * DELETE /api/config/account - Clear freee account credentials
 */
router.delete('/account', (req, res) => {
  setSetting('freee_username', '');
  setSetting('freee_username_encrypted', '');
  setSetting('freee_password_encrypted', '');
  setSetting('freee_configured', '0');

  res.json({ success: true, freee_configured: false });
});

/**
 * POST /api/config/verify-credentials - Verify freee account credentials
 * Dispatches to API mode or browser mode based on connection_mode setting.
 */
router.post('/verify-credentials', async (req, res) => {
  const mode = getSetting('connection_mode') || 'browser';

  if (mode === 'api') {
    // API mode: verify OAuth connection
    if (getSetting('oauth_configured') !== '1') {
      return res.status(400).json({ valid: false, error: 'OAuth not configured. Complete authorization first.' });
    }
    try {
      const client = new FreeeApiClient();
      const info = await client.verifyConnection();
      res.json({ valid: true, user_info: info });
    } catch (e) {
      res.json({ valid: false, error: e.message });
    }
    return;
  }

  // Browser mode: use Playwright login
  const creds = resolveCredentials();
  if (!creds) {
    return res.status(400).json({ valid: false, error: 'No credentials configured' });
  }
  const result = await verifyFreeeLogin(creds.username, creds.password);
  res.json(result);
});

// ─── Connection Mode & OAuth Routes ────────────────────────

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

/**
 * GET /api/config/connection-mode - Get current connection mode + OAuth status
 */
router.get('/connection-mode', (req, res) => {
  res.json({
    connection_mode: getSetting('connection_mode') || 'browser',
    oauth_configured: getSetting('oauth_configured') === '1',
  });
});

/**
 * PUT /api/config/connection-mode - Set connection mode ('browser' or 'api')
 */
router.put('/connection-mode', async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['browser', 'api'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "browser" or "api"' });
    }
    setSetting('connection_mode', mode);

    // Re-initialize scheduler to re-detect state with the new mode
    try {
      await scheduler.initialize();
    } catch (schedErr) {
      console.error('[Config] Scheduler re-init failed after mode change:', schedErr.message);
    }

    res.json({ connection_mode: mode });
  } catch (err) {
    console.error('[Config] Error setting connection mode:', err.message);
    res.status(500).json({ error: 'Failed to set connection mode' });
  }
});

/**
 * PUT /api/config/oauth-app - Save OAuth client_id and client_secret
 */
router.put('/oauth-app', (req, res) => {
  const { client_id, client_secret } = req.body;
  if (!client_id || !client_secret) {
    return res.status(400).json({ error: 'Both client_id and client_secret are required' });
  }

  setSetting('oauth_client_id', client_id);
  setSetting('oauth_client_secret_encrypted', encrypt(client_secret));

  res.json({ success: true });
});

/**
 * GET /api/config/oauth-authorize-url - Generate freee OAuth authorization URL
 */
router.get('/oauth-authorize-url', (req, res) => {
  const clientId = getSetting('oauth_client_id');
  if (!clientId) {
    return res.status(400).json({ error: 'OAuth client_id not configured. Save your app credentials first.' });
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}/api/config/oauth-callback`;

  // Generate CSRF state token (RFC 6749 §10.12)
  const state = crypto.randomBytes(32).toString('hex');
  setSetting('oauth_state', state);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    prompt: 'consent',
    state,
  });

  res.json({ url: `${AUTHORIZE_URL}?${params.toString()}`, redirect_uri: redirectUri });
});

/**
 * GET /api/config/oauth-callback - Handle freee OAuth redirect (AUTH-EXEMPT)
 * Exchanges authorization code for tokens, fetches user info, stores everything.
 * Returns HTML that notifies the opener window and auto-closes.
 */
router.get('/oauth-callback', async (req, res) => {
  const { code, error: oauthError, state } = req.query;

  if (oauthError) {
    return res.send(callbackHtml(`Authorization denied: ${oauthError}`, false));
  }
  if (!code) {
    return res.send(callbackHtml('No authorization code received', false));
  }

  // Validate CSRF state token (RFC 6749 §10.12)
  const expectedState = getSetting('oauth_state');
  if (!state || !expectedState || state !== expectedState) {
    return res.send(callbackHtml('Invalid state parameter — possible CSRF attack', false));
  }
  // Clear state after validation (single-use)
  setSetting('oauth_state', '');

  const clientId = getSetting('oauth_client_id');
  const clientSecret = decrypt(getSetting('oauth_client_secret_encrypted'));

  if (!clientId || !clientSecret) {
    return res.send(callbackHtml('OAuth app credentials missing. Please save them first.', false));
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI ||
    `${req.protocol}://${req.get('host')}/api/config/oauth-callback`;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('[OAuth] Token exchange failed:', tokenRes.status, errBody.substring(0, 200));
      return res.send(callbackHtml(`Token exchange failed (${tokenRes.status})`, false));
    }

    const tokenData = await tokenRes.json();

    // Store tokens (encrypted)
    setSetting('oauth_access_token_encrypted', encrypt(tokenData.access_token));
    setSetting('oauth_refresh_token_encrypted', encrypt(tokenData.refresh_token));
    setSetting('oauth_token_expires_at', String(Math.floor(Date.now() / 1000) + tokenData.expires_in));

    // Fetch user info to get company_id and employee_id
    const userRes = await fetch('https://api.freee.co.jp/hr/api/v1/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (userRes.ok) {
      const userData = await userRes.json();
      const companies = userData.companies || [];

      // Store all available companies for later selection
      setSetting('oauth_companies', JSON.stringify(companies.map(c => ({
        id: c.id,
        employee_id: c.employee_id,
        name: c.name || `Company ${c.id}`,
        display_name: c.display_name || '',
        role: c.role || '',
      }))));
      setSetting('oauth_user_id', String(userData.id || ''));
      setSetting('oauth_user_display_name', userData.display_name || '');
      setSetting('oauth_user_email', userData.email || '');

      if (companies.length === 1) {
        // Single company: auto-select
        const cid = String(companies[0].id);
        const eid = String(companies[0].employee_id);
        setSetting('oauth_company_id', cid);
        setSetting('oauth_employee_id', eid);
        setSetting('oauth_company_name', companies[0].name || '');

        // Store display_name from company data as fallback
        if (companies[0].display_name) {
          setSetting('oauth_user_display_name', companies[0].display_name);
        }

        // Fetch employee details to get employee number (社員番号)
        try {
          const empRes = await fetch(`https://api.freee.co.jp/hr/api/v1/employees/${eid}?company_id=${cid}`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (empRes.ok) {
            const empData = await empRes.json();
            setSetting('oauth_employee_num', empData.num || '');
            if (empData.display_name) {
              setSetting('oauth_user_display_name', empData.display_name);
            }
          }
        } catch (e) {
          console.log('[OAuth] Could not fetch employee details:', e.message);
        }
      } else if (companies.length > 1) {
        // Multiple companies: don't auto-select, let user choose
        console.log(`[OAuth] ${companies.length} companies found, user needs to select one`);
      }
    }

    setSetting('oauth_configured', '1');
    console.log('[OAuth] Authorization completed successfully');

    return res.send(callbackHtml('Authorization successful!', true));
  } catch (e) {
    console.error('[OAuth] Callback error:', e.message);
    return res.send(callbackHtml(`Error: ${e.message}`, false));
  }
});

/**
 * GET /api/config/oauth-status - Get OAuth configuration status
 */
router.get('/oauth-status', (req, res) => {
  const configured = getSetting('oauth_configured') === '1';
  const clientId = getSetting('oauth_client_id') || '';
  const companyId = getSetting('oauth_company_id') || '';
  const employeeId = getSetting('oauth_employee_id') || '';
  const companyName = getSetting('oauth_company_name') || '';
  const expiresAt = parseInt(getSetting('oauth_token_expires_at') || '0', 10);
  const userId = getSetting('oauth_user_id') || '';
  const userDisplayName = getSetting('oauth_user_display_name') || '';
  const userEmail = getSetting('oauth_user_email') || '';
  const employeeNum = getSetting('oauth_employee_num') || '';

  // Parse available companies
  let companies = [];
  try {
    companies = JSON.parse(getSetting('oauth_companies') || '[]');
  } catch { /* ignore */ }

  // If display_name is empty, try to get it from the selected company's data
  let resolvedDisplayName = userDisplayName;
  if (!resolvedDisplayName && companyId && companies.length > 0) {
    const selectedCompany = companies.find(c => String(c.id) === String(companyId));
    if (selectedCompany && selectedCompany.display_name) {
      resolvedDisplayName = selectedCompany.display_name;
    }
  }

  res.json({
    configured,
    client_id_masked: clientId ? clientId.slice(0, 8) + '...' : '',
    company_id: companyId,
    employee_id: employeeId,
    company_name: companyName,
    companies,
    needs_company_selection: configured && companies.length > 1 && !companyId,
    user_id: userId,
    user_display_name: resolvedDisplayName,
    user_email: userEmail,
    employee_num: employeeNum,
    token_expires_at: expiresAt,
    token_valid: expiresAt > Math.floor(Date.now() / 1000),
  });
});

/**
 * PUT /api/config/oauth-select-company - Select which company to use (for multi-company accounts)
 */
router.put('/oauth-select-company', async (req, res) => {
  const { company_id } = req.body;
  if (!company_id) {
    return res.status(400).json({ error: 'company_id is required' });
  }

  let companies = [];
  try {
    companies = JSON.parse(getSetting('oauth_companies') || '[]');
  } catch { /* ignore */ }

  const selected = companies.find(c => String(c.id) === String(company_id));
  if (!selected) {
    return res.status(400).json({ error: 'Company not found in authorized companies' });
  }

  const cid = String(selected.id);
  const eid = selected.employee_id ? String(selected.employee_id) : '';
  setSetting('oauth_company_id', cid);
  setSetting('oauth_employee_id', eid);
  setSetting('oauth_company_name', selected.name || '');

  // Store display_name from company data as fallback
  if (selected.display_name) {
    setSetting('oauth_user_display_name', selected.display_name);
  }

  // Fetch employee details to get employee number and display name
  let employeeNum = '';
  if (eid) {
    try {
      const { FreeeApiClient } = await import('../freee-api.js');
      const client = new FreeeApiClient();
      const token = await client.ensureValidToken();
      const empRes = await fetch(`https://api.freee.co.jp/hr/api/v1/employees/${eid}?company_id=${cid}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (empRes.ok) {
        const empData = await empRes.json();
        employeeNum = empData.num || '';
        setSetting('oauth_employee_num', employeeNum);
        if (empData.display_name) {
          setSetting('oauth_user_display_name', empData.display_name);
        }
      }
    } catch (e) {
      console.log('[OAuth] Could not fetch employee details:', e.message);
    }
  } else {
    console.log(`[OAuth] Warning: No employee_id for company ${selected.name} (ID: ${cid}). Employee record needs to be created in freee HR admin.`);
  }

  console.log(`[OAuth] Selected company: ${selected.name} (ID: ${cid})`);

  // Re-initialize scheduler so it re-detects state for the new company
  // Without this, startup_analysis retains the previous company's cached state
  try {
    await scheduler.initialize();
    console.log('[OAuth] Scheduler re-initialized for new company');
  } catch (e) {
    console.warn('[OAuth] Scheduler re-init failed:', e.message);
  }

  res.json({
    success: true,
    company_id: cid,
    employee_id: eid,
    company_name: selected.name || '',
    employee_num: employeeNum,
  });
});

/**
 * POST /api/config/oauth-verify - Verify OAuth API connection
 */
router.post('/oauth-verify', async (req, res) => {
  if (getSetting('oauth_configured') !== '1') {
    return res.status(400).json({ valid: false, error: 'OAuth not configured' });
  }
  try {
    const client = new FreeeApiClient();
    const info = await client.verifyConnection();
    res.json({ valid: true, user_info: info });
  } catch (e) {
    res.json({ valid: false, error: e.message });
  }
});

/**
 * DELETE /api/config/oauth - Clear all OAuth data
 */
router.delete('/oauth', (req, res) => {
  setSetting('oauth_client_id', '');
  setSetting('oauth_client_secret_encrypted', '');
  setSetting('oauth_access_token_encrypted', '');
  setSetting('oauth_refresh_token_encrypted', '');
  setSetting('oauth_token_expires_at', '0');
  setSetting('oauth_company_id', '');
  setSetting('oauth_employee_id', '');
  setSetting('oauth_company_name', '');
  setSetting('oauth_companies', '[]');
  setSetting('oauth_user_id', '');
  setSetting('oauth_user_display_name', '');
  setSetting('oauth_user_email', '');
  setSetting('oauth_employee_num', '');
  setSetting('oauth_configured', '0');

  res.json({ success: true });
});

/**
 * Generate HTML for the OAuth callback popup window.
 * Notifies the opener via postMessage and auto-closes.
 */
/**
 * Sanitize string for safe HTML insertion (prevent XSS).
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function callbackHtml(message, success) {
  const safeMessage = escapeHtml(message);
  const safeMessageJs = safeMessage.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `<!DOCTYPE html>
<html><head><title>PunchPilot OAuth</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  .msg { font-size: 16px; color: #333; margin-bottom: 16px; }
  .hint { font-size: 13px; color: #888; }
</style></head>
<body><div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <div class="msg">${safeMessage}</div>
  <div class="hint">This window will close automatically...</div>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-callback-${success ? 'success' : 'error'}', message: '${safeMessageJs}' }, window.location.origin);
  }
  setTimeout(() => window.close(), 2000);
</script>
</body></html>`;
}

/**
 * PUT /api/config/:actionType - Update a schedule configuration
 */
router.put('/:actionType', async (req, res) => {
  const { actionType } = req.params;

  if (!VALID_ACTIONS.includes(actionType)) {
    return res.status(400).json({ error: `Invalid action type. Must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  const { mode, fixed_time, window_start, window_end, enabled } = req.body;

  // Validate mode
  if (mode && !['fixed', 'random'].includes(mode)) {
    return res.status(400).json({ error: 'Mode must be "fixed" or "random"' });
  }

  // Validate time formats
  if (fixed_time && !TIME_REGEX.test(fixed_time)) {
    return res.status(400).json({ error: 'fixed_time must be in HH:MM format' });
  }
  if (window_start && !TIME_REGEX.test(window_start)) {
    return res.status(400).json({ error: 'window_start must be in HH:MM format' });
  }
  if (window_end && !TIME_REGEX.test(window_end)) {
    return res.status(400).json({ error: 'window_end must be in HH:MM format' });
  }

  // Validate window: start < end (check both submitted and existing values)
  {
    const currentConfig = getConfigByAction(actionType);
    const effStart = window_start || currentConfig?.window_start;
    const effEnd = window_end || currentConfig?.window_end;
    if (effStart && effEnd) {
      if (timeToMinutes(effStart) >= timeToMinutes(effEnd)) {
        return res.status(400).json({ error: 'window_start must be before window_end' });
      }
    }
  }

  // Validate break duration minimum 60 minutes
  // Applies to BOTH fixed and random modes:
  //   - fixed: break_end.fixed_time - break_start.fixed_time >= 60
  //   - random: break_end.window_end - break_start.window_start >= 60
  //     (ensures at least 60 minutes of selectable break range)
  if (actionType === 'break_end' || actionType === 'break_start') {
    const breakStartConfig = getConfigByAction('break_start');
    const breakEndConfig = getConfigByAction('break_end');

    const effectiveStartMode = actionType === 'break_start' ? (mode || breakStartConfig?.mode) : breakStartConfig?.mode;
    const effectiveEndMode = actionType === 'break_end' ? (mode || breakEndConfig?.mode) : breakEndConfig?.mode;

    // Determine the earliest possible break start and latest possible break end
    let earliestStart = null;
    let latestEnd = null;

    if (effectiveStartMode === 'fixed') {
      earliestStart = actionType === 'break_start' ? (fixed_time || breakStartConfig?.fixed_time) : breakStartConfig?.fixed_time;
    } else {
      // random: earliest start = window_start of break_start
      earliestStart = actionType === 'break_start' ? (window_start || breakStartConfig?.window_start) : breakStartConfig?.window_start;
    }

    if (effectiveEndMode === 'fixed') {
      latestEnd = actionType === 'break_end' ? (fixed_time || breakEndConfig?.fixed_time) : breakEndConfig?.fixed_time;
    } else {
      // random: latest end = window_end of break_end
      latestEnd = actionType === 'break_end' ? (window_end || breakEndConfig?.window_end) : breakEndConfig?.window_end;
    }

    if (earliestStart && latestEnd) {
      const duration = timeToMinutes(latestEnd) - timeToMinutes(earliestStart);
      if (duration < 60) {
        return res.status(400).json({ error: 'Break duration must be at least 60 minutes' });
      }
    }
  }

  // Build update data
  const data = {};
  if (mode !== undefined) data.mode = mode;
  if (fixed_time !== undefined) data.fixed_time = fixed_time;
  if (window_start !== undefined) data.window_start = window_start;
  if (window_end !== undefined) data.window_end = window_end;
  if (enabled !== undefined) data.enabled = enabled ? 1 : 0;

  updateConfig(actionType, data);

  // Re-initialize scheduler with new config
  await scheduler.initialize();

  const updated = getConfigByAction(actionType);
  res.json(updated);
});

export default router;
