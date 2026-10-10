import { Router } from 'express';
import { isTimeString, timeToMinutes } from '../../shared/date-time.js';
import { ACTION_TYPES, resolveBreakTimes } from '../../shared/schedule-policy.js';
import { parseExternalId } from '../freee-values.js';
import crypto from 'crypto';
import {
  getAllConfig,
  getConfigByAction,
  updateConfig,
  getSetting,
  setSetting,
  setSettingsAtomically,
  setSettingsAtomicallyIfCurrent,
} from '../db.js';
import { scheduler } from '../scheduler.js';
import { encrypt, decrypt } from '../crypto.js';
import {
  FREEE_API_ERROR_CODES,
  FREEE_AUTH_ERROR_CODES,
  FreeeApiClient,
  assertOAuthCompanyIdentity,
  assertOAuthIdentityBinding,
  getAuthorizedOAuthCompanies,
  isOAuthReady,
} from '../freee-api.js';
import {
  AUTOMATION_OPERATION_TIMEOUT_MS,
  automationRuntime,
  withDeadline,
} from '../automation/runtime.js';
import { acquireLock, releaseLock } from '../automation/constants.js';
import { authenticateFreeeWeb } from '../automation/web-login.js';
import { readWebEmployeeIdentity } from '../automation/web-work-record.js';
import { PunchBot } from '../automation/punch-bot.js';
import { getWebCompanyName, getWebAccountSnapshot } from '../automation/utils.js';
import { safeErrorMetadata } from '../logger.js';
import {
  getOAuthIdentityGeneration,
  isWebAccountVerified,
  nextIdentityGeneration,
} from '../automation/identity.js';
import {
  beginAccountOperationShutdown,
  withAccountOperation,
} from '../account-operation.js';
import { resolveOAuthRedirectUri } from '../public-origin.js';
import { normalizeAutomationErrorCode } from '../automation-diagnostics.js';

const router = Router();

const VALID_ACTIONS = ACTION_TYPES;
const WEB_USERNAME_MAX_BYTES = 320;
const WEB_PASSWORD_MAX_BYTES = 1024;
const OAUTH_CLIENT_ID_MAX_BYTES = 1024;
const OAUTH_CLIENT_SECRET_MAX_BYTES = 4096;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_PENDING_GENERATION_PATTERN = /^(\d+):([a-f0-9]{32})$/;

function hasBoundedBytes(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function maskIdentifier(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  const at = text.indexOf('@');
  if (at > 0) {
    return `${text.slice(0, Math.min(3, at))}***${text.slice(at)}`;
  }
  return `${text.slice(0, 3)}***`;
}

function normalizeOAuthId(value) {
  const id = parseExternalId(value);
  return id == null ? '' : String(id);
}

function oauthStateMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function pendingOAuthIdentityGeneration(value) {
  const match = String(value || '').match(OAUTH_PENDING_GENERATION_PATTERN);
  return match ? match[1] : null;
}

function newPendingOAuthGeneration(identityGeneration) {
  return `${identityGeneration}:${crypto.randomBytes(16).toString('hex')}`;
}

async function clearPendingOAuthAuthorization(pendingGeneration, identityGeneration) {
  return withAccountOperation(() =>
    setSettingsAtomicallyIfCurrent(
      [
        ['oauth_state', ''],
        ['oauth_state_generation', pendingGeneration],
        ['oauth_identity_generation', identityGeneration],
      ],
      [
        ['oauth_state_issued_at', '0'],
        ['oauth_state_generation', ''],
      ],
    ),
  );
}

async function mutateAutomationConfiguration(operation, options) {
  scheduler.stopAll();
  try {
    const result = await withAccountOperation(operation);
    await scheduler.initialize(options);
    return result;
  } catch (error) {
    await scheduler.initialize().catch((schedulerError) => {
      console.error(
        '[Config] Scheduler recovery failed after configuration error',
        safeErrorMetadata(schedulerError),
      );
    });
    throw error;
  }
}

/**
 * Shared verify function: attempt login to freee with given credentials.
 * Returns { valid: boolean, error?: string }
 */
async function verifyFreeeLogin(username, password) {
  console.log('[Verify] Attempting freee Web login');

  let context = null;
  let verificationError = null;
  let fatalRuntimeSignaled = false;
  const signalFatalRuntime = (error) => {
    if (fatalRuntimeSignaled || !automationRuntime.isUnrecoverable()) return;
    fatalRuntimeSignaled = true;
    beginAccountOperationShutdown();
    process.emit(
      'punchpilot:automation-unrecoverable',
      automationRuntime.getUnrecoverableError?.() || error,
    );
  };
  const closeVerificationContext = async () => {
    const current = context;
    context = null;
    try {
      return await automationRuntime.closeContext(current);
    } catch (error) {
      signalFatalRuntime(error);
      throw error;
    }
  };
  await acquireLock();
  try {
    return await withDeadline(async (signal) => {
      try {
        signal.throwIfAborted();
        context = await automationRuntime.openContext({
          useStoredSession: false,
          signal,
        });
        signal.throwIfAborted();
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
        await authenticateFreeeWeb(page, { username, password });
        signal.throwIfAborted();
        const companyVerifier = new PunchBot();
        companyVerifier.page = page;
        await companyVerifier.ensureCompany();
        signal.throwIfAborted();
        const { employeeId } = await readWebEmployeeIdentity(page);
        console.log('[Verify] freee Web login confirmed');
        return { valid: true, employeeId };
      } finally {
        if (signal.aborted) await closeVerificationContext();
      }
    }, AUTOMATION_OPERATION_TIMEOUT_MS, {
      onTimeout: () => context
        ? closeVerificationContext()
        : automationRuntime.closeBrowser(),
    });
  } catch (e) {
    verificationError = e;
    console.error('[Verify] Credential verification failed', safeErrorMetadata(e));
    const code = normalizeAutomationErrorCode(e?.code) || 'WEB_AUTOMATION_FAILED';
    const messages = new Map([
      ['WEB_LOGIN_FAILED', 'Login failed - please check your credentials'],
      ['WEB_LOGIN_INTERACTION_REQUIRED', 'Interactive verification is required in freee Web'],
      ['WEB_LOGIN_UNCONFIRMED', 'Login result could not be confirmed from the attendance page'],
      ['WEB_COMPANY_TARGET_REQUIRED', 'Configure the exact freee company name before using Web automation'],
      ['WEB_COMPANY_SELECTION_UNCONFIRMED', 'The configured freee company could not be confirmed'],
    ]);
    return {
      valid: false,
      error: messages.get(code) || 'Credential verification could not complete',
      code,
    };
  } finally {
    let cleanupError = null;
    try {
      await closeVerificationContext();
    } catch (error) {
      cleanupError = error;
    } finally {
      signalFatalRuntime(cleanupError || verificationError);
      releaseLock();
    }
    if (cleanupError && verificationError) {
      console.warn(
        '[Verify] Browser cleanup also failed',
        safeErrorMetadata(cleanupError),
      );
    } else if (cleanupError) {
      throw cleanupError;
    }
  }
}

/**
 * Resolve current freee credentials (GUI > env).
 * Returns { username, password } or null if none configured.
 */
function resolveCredentials() {
  const account = getWebAccountSnapshot();
  return account.valid ? { username: account.username, password: account.password } : null;
}

async function runOAuthVerify() {
  if (!isOAuthReady()) {
    return {
      status: 400,
      body: {
        valid: false,
        error: 'OAuth is not ready. Complete authorization and select a valid company.',
      },
    };
  }
  try {
    const client = new FreeeApiClient();
    const info = await client.verifyConnection();
    return { status: 200, body: { valid: true, user_info: info } };
  } catch (e) {
    const errorCode = normalizeAutomationErrorCode(e?.code) || 'API_ACTION_FAILED';
    const messages = new Map([
      [FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED, 'OAuth authorization must be renewed.'],
      [FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT, 'OAuth verification is temporarily unavailable.'],
      [FREEE_API_ERROR_CODES.PERMISSION_DENIED, 'freee API permission was denied.'],
      [FREEE_API_ERROR_CODES.RATE_LIMITED, 'freee API rate limit was reached. Try again later.'],
      [FREEE_API_ERROR_CODES.API_TRANSIENT, 'freee API is temporarily unavailable.'],
    ]);
    return {
      status: 200,
      body: {
        valid: false,
        error: messages.get(errorCode) || 'OAuth verification failed.',
        error_code: errorCode,
      },
    };
  }
}

async function runWebVerify() {
  return mutateAutomationConfiguration(async () => {
    const account = getWebAccountSnapshot();
    const creds = account.valid ? account : null;
    if (!creds) {
      return {
        status: 400,
        body: {
          valid: false,
          web_identity_verified: false,
          error: 'No usable credentials configured',
          code: account.code || 'WEB_CREDENTIALS_REQUIRED',
        },
      };
    }
    const expected = [
      ['freee_configured', getSetting('freee_configured') || '0'],
      ['freee_username_encrypted', getSetting('freee_username_encrypted') || ''],
      ['freee_password_encrypted', getSetting('freee_password_encrypted') || ''],
      ['web_company_name', getSetting('web_company_name') || ''],
      ['web_employee_id_encrypted', getSetting('web_employee_id_encrypted') || ''],
      ['web_identity_generation', getSetting('web_identity_generation') || '0'],
      ['web_verified_credential_digest', getSetting('web_verified_credential_digest') || ''],
    ];
    const result = await verifyFreeeLogin(creds.username, creds.password);
    if (!result.valid) {
      return {
        status: 200,
        body: {
          ...result,
          web_identity_verified: isWebAccountVerified(),
        },
      };
    }
    const currentAccount = getWebAccountSnapshot();
    if (account.verificationDigest !== currentAccount.verificationDigest ||
        account.employeeId !== currentAccount.employeeId) {
      return { status: 409, body: { valid: false, error: 'Web account changed during verification', code: 'WEB_ACCOUNT_IDENTITY_CHANGED' } };
    }
    if (account.source === 'environment' && process.env.FREEE_EMPLOYEE_ID && account.employeeId !== result.employeeId) {
      return { status: 200, body: { valid: false, web_identity_verified: false,
        error: 'The configured employee does not match the signed-in Web account.', code: 'WEB_EMPLOYEE_BINDING_REQUIRED' } };
    }
    const generation = nextIdentityGeneration('web_identity_generation');
    const stored = setSettingsAtomicallyIfCurrent(expected, [
      ['web_employee_id_encrypted', encrypt(result.employeeId)],
      ['web_verified_credential_digest', account.verificationDigest],
      ['web_identity_generation', generation],
    ]);
    if (!stored) {
      return {
        status: 409,
        body: {
          valid: false,
          web_identity_verified: isWebAccountVerified(),
          error: 'The Web account configuration changed during verification.',
          code: 'WEB_ACCOUNT_IDENTITY_CHANGED',
        },
      };
    }
    automationRuntime.invalidateSession();
    return {
      status: 200,
      body: { valid: true, web_identity_verified: true },
    };
  });
}

/**
 * GET /api/config - Get all schedule configurations + system info
 */
router.get('/', (req, res) => {
  const configs = getAllConfig();
  const autoEnabled = getSetting('auto_checkin_enabled') === '1';
  const debugMode = getSetting('debug_mode') === '1';
  const freeeConfigured = getSetting('freee_configured') === '1';
  const webCredentialsConfigured = Boolean(resolveCredentials());
  const freeeUsername = decrypt(getSetting('freee_username_encrypted') || '') || '';
  const connectionMode = getSetting('connection_mode') || 'api';
  const oauthConfigured = isOAuthReady();
  const oauthCompanyId = oauthConfigured ? getSetting('oauth_company_id') || '' : '';
  const holidaySkipCountries = getSetting('holiday_skip_countries') || 'jp';

  res.json({
    auto_checkin_enabled: autoEnabled,
    debug_mode: debugMode,
    freee_configured: freeeConfigured,
    web_credentials_configured: webCredentialsConfigured,
    freee_username: freeeUsername,
    web_identity_verified: isWebAccountVerified(),
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
  const newValue = await mutateAutomationConfiguration(() => {
    const current = getSetting('auto_checkin_enabled');
    const value = current === '1' ? '0' : '1';
    setSetting('auto_checkin_enabled', value);
    return value;
  });

  res.json({ auto_checkin_enabled: newValue === '1' });
});

/**
 * PUT /api/config/holiday-skip-countries - Set which countries' holidays to skip for auto-punch
 * Body: { countries: "jp" | "cn" | "jp,cn" }
 */
router.put('/holiday-skip-countries', async (req, res) => {
  const { countries } = req.body || {};
  if (!countries || typeof countries !== 'string') {
    return res.status(400).json({ error: 'countries is required (comma-separated: jp,cn)' });
  }
  const normalizedCountries = countries.split(',').map((country) => country.trim());
  const valid =
    normalizedCountries.length <= 2 &&
    normalizedCountries.every((country) => ['jp', 'cn'].includes(country)) &&
    new Set(normalizedCountries).size === normalizedCountries.length;
  if (!valid) {
    return res.status(400).json({ error: 'Invalid country code. Supported: jp, cn' });
  }
  const normalized = normalizedCountries.join(',');
  await mutateAutomationConfiguration(() =>
    setSetting('holiday_skip_countries', normalized));
  res.json({ holiday_skip_countries: normalized });
});

/**
 * PUT /api/config/debug - Toggle debug/mock mode
 */
router.put('/debug', async (req, res) => {
  const newValue = await mutateAutomationConfiguration(() => {
    const current = getSetting('debug_mode');
    const value = current === '1' ? '0' : '1';
    setSetting('debug_mode', value);
    return value;
  });
  res.json({ debug_mode: newValue === '1' });
});

/**
 * PUT /api/config/debug/set - Set debug mode explicitly
 */
router.put('/debug/set', async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  const val = enabled ? '1' : '0';
  await mutateAutomationConfiguration(() => setSetting('debug_mode', val));
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
    web_credentials_configured: Boolean(resolveCredentials()),
    freee_username: freeeUsername,
    freee_company_name: getWebCompanyName(),
    web_identity_verified: isWebAccountVerified(),
    has_env_credentials: hasEnvCreds,
    env_username: maskIdentifier(process.env.LOGIN_USERNAME),
  });
});

/**
 * PUT /api/config/account - Save freee account credentials (encrypted)
 * Save only — no auto-verify. Verification is a separate action via POST /verify-credentials.
 */
router.put('/account', async (req, res) => {
  try {
    const { username, password, company_name } = req.body || {};
    const normalizedUsername = typeof username === 'string' ? username.trim() : '';

    if (
      !normalizedUsername ||
      !hasBoundedBytes(normalizedUsername, WEB_USERNAME_MAX_BYTES) ||
      hasControlCharacters(normalizedUsername) ||
      !hasBoundedBytes(password, WEB_PASSWORD_MAX_BYTES) ||
      password.length === 0 ||
      password.includes('\u0000')
    ) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const currentCompanyName = (
      getSetting('web_company_name') ||
      process.env.FREEE_COMPANY_NAME ||
      ''
    ).trim();
    if (company_name !== undefined && typeof company_name !== 'string') {
        return res.status(400).json({
          error: 'company_name must contain 1 to 200 characters',
          code: 'INVALID_WEB_COMPANY_NAME',
        });
    }
    const companyName = company_name === undefined
      ? currentCompanyName
      : company_name.trim();
    if (
      !companyName ||
      companyName.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(companyName)
    ) {
      return res.status(400).json({
        error: 'company_name must contain 1 to 200 characters',
        code: 'INVALID_WEB_COMPANY_NAME',
      });
    }

    let generation;
    await mutateAutomationConfiguration(async () => {
      generation = nextIdentityGeneration('web_identity_generation');
      setSettingsAtomically([
        ['freee_username_encrypted', encrypt(normalizedUsername)],
        ['freee_password_encrypted', encrypt(password)],
        ['freee_username', ''],
        ['freee_configured', '1'],
        ['web_company_name', companyName],
        ['web_employee_id_encrypted', ''],
      ['web_verified_credential_digest', ''],
        ['web_identity_generation', generation],
      ]);
      automationRuntime.invalidateSession();
    });

    console.log('[Config] Credentials saved');

    res.json({
      success: true,
      freee_configured: true,
      web_credentials_configured: true,
      freee_username: normalizedUsername,
      freee_company_name: getWebCompanyName(),
      web_identity_verified: false,
    });
  } catch (err) {
    console.error('[Config] Error saving account', safeErrorMetadata(err));
    res.status(500).json({ error: 'Failed to save credentials' });
  }
});

/**
 * DELETE /api/config/account - Clear freee account credentials
 */
router.delete('/account', async (req, res) => {
  let generation;
  await mutateAutomationConfiguration(async () => {
    generation = nextIdentityGeneration('web_identity_generation');
    setSettingsAtomically([
      ['freee_username', ''],
      ['freee_username_encrypted', ''],
      ['freee_password_encrypted', ''],
      ['web_company_name', ''],
      ['web_employee_id_encrypted', ''],
      ['web_verified_credential_digest', ''],
      ['freee_configured', '0'],
      ['web_identity_generation', generation],
    ]);
    automationRuntime.invalidateSession();
  });

  res.json({
    success: true,
    freee_configured: false,
    web_credentials_configured: Boolean(resolveCredentials()),
    web_identity_verified: false,
  });
});

/**
 * POST /api/config/verify-credentials - Verify freee account credentials
 * Dispatches to API mode or browser mode based on connection_mode setting.
 */
router.post('/verify-credentials', async (req, res) => {
  const mode = getSetting('connection_mode') || 'api';

  if (mode === 'api') {
    const result = await runOAuthVerify();
    return res.status(result.status).json(result.body);
  }

  const result = await runWebVerify();
  return res.status(result.status).json(result.body);
});

/**
 * POST /api/config/verify-web-credentials - Verify freee Web credentials only
 */
router.post('/verify-web-credentials', async (req, res) => {
  const result = await runWebVerify();
  return res.status(result.status).json(result.body);
});

/**
 * POST /api/config/verify-oauth - Verify OAuth API connection only
 */
router.post('/verify-oauth', async (req, res) => {
  const result = await runOAuthVerify();
  return res.status(result.status).json(result.body);
});

// ─── Connection Mode & OAuth Routes ────────────────────────

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const OAUTH_FETCH_TIMEOUT_MS = 30_000;

async function fetchOAuth(url, options = {}) {
  if (
    options.signal ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS) });
}

function clearedOAuthCompanyEntries() {
  return [
    ['oauth_company_id', ''],
    ['oauth_employee_id', ''],
    ['oauth_company_name', ''],
    ['oauth_companies', '[]'],
    ['oauth_user_id', ''],
    ['oauth_user_display_name', ''],
    ['oauth_user_email', ''],
    ['oauth_employee_num', ''],
    ['oauth_configured', '0'],
  ];
}

/**
 * GET /api/config/connection-mode - Get current connection mode + OAuth status
 */
router.get('/connection-mode', (req, res) => {
  res.json({
    connection_mode: getSetting('connection_mode') || 'api',
    oauth_configured: isOAuthReady(),
  });
});

/**
 * PUT /api/config/connection-mode - Set connection mode ('browser' or 'api')
 */
router.put('/connection-mode', async (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!['browser', 'api'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "browser" or "api"' });
    }
    await mutateAutomationConfiguration(() => setSetting('connection_mode', mode));

    res.json({ connection_mode: mode });
  } catch (err) {
    console.error('[Config] Error setting connection mode', safeErrorMetadata(err));
    res.status(500).json({ error: 'Failed to set connection mode' });
  }
});

/**
 * PUT /api/config/oauth-app - Save OAuth client_id and client_secret
 */
router.put('/oauth-app', async (req, res) => {
  const { client_id, client_secret } = req.body || {};
  const normalizedClientId = typeof client_id === 'string' ? client_id.trim() : '';
  if (
    !normalizedClientId ||
    !hasBoundedBytes(normalizedClientId, OAUTH_CLIENT_ID_MAX_BYTES) ||
    hasControlCharacters(normalizedClientId) ||
    !hasBoundedBytes(client_secret, OAUTH_CLIENT_SECRET_MAX_BYTES) ||
    client_secret.length === 0 ||
    client_secret.includes('\u0000')
  ) {
    return res.status(400).json({ error: 'Both client_id and client_secret are required' });
  }

  await mutateAutomationConfiguration(() => {
    const generation = nextIdentityGeneration('oauth_identity_generation');
    return setSettingsAtomically([
    ['oauth_client_id', normalizedClientId],
    ['oauth_client_secret_encrypted', encrypt(client_secret)],
    ['oauth_access_token_encrypted', ''],
    ['oauth_refresh_token_encrypted', ''],
    ['oauth_token_expires_at', '0'],
    ['oauth_state', ''],
    ['oauth_state_issued_at', '0'],
    ['oauth_state_generation', ''],
    ['oauth_identity_generation', generation],
    ...clearedOAuthCompanyEntries(),
    ['oauth_auth_broken', '0'],
    ['oauth_auth_broken_since', ''],
    ['oauth_auth_broken_reason', ''],
    ]);
  });

  res.json({ success: true });
});

/**
 * POST /api/config/oauth-authorize-url - Generate freee OAuth authorization URL
 */
router.post('/oauth-authorize-url', async (req, res) => {
  const clientId = getSetting('oauth_client_id');
  if (!clientId) {
    return res.status(400).json({ error: 'OAuth client_id not configured. Save your app credentials first.' });
  }

  let redirectUri;
  try {
    redirectUri = resolveOAuthRedirectUri(req);
  } catch (error) {
    console.error('[OAuth] Public origin configuration invalid', safeErrorMetadata(error));
    return res.status(503).json({ error: 'Public origin configuration is invalid' });
  }

  // Generate CSRF state token (RFC 6749 §10.12)
  const state = crypto.randomBytes(32).toString('hex');
  const identityGeneration = getOAuthIdentityGeneration();
  const pendingGeneration = newPendingOAuthGeneration(identityGeneration);
  const stateStored = await withAccountOperation(() =>
    setSettingsAtomicallyIfCurrent(
      [
        ['oauth_client_id', clientId],
        ['oauth_identity_generation', identityGeneration],
      ],
      [
        ['oauth_state', state],
        ['oauth_state_issued_at', String(Date.now())],
        ['oauth_state_generation', pendingGeneration],
      ],
    ),
  );
  if (!stateStored) {
    return res.status(409).json({
      error: 'OAuth configuration changed while authorization was starting. Please retry.',
    });
  }

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

  // Validate CSRF state token (RFC 6749 §10.12)
  const expectedState = getSetting('oauth_state');
  const expectedStateIssuedAt = getSetting('oauth_state_issued_at') || '0';
  const stateIssuedAt = Number.parseInt(expectedStateIssuedAt, 10);
  const pendingGeneration = getSetting('oauth_state_generation') || '';
  const identityGeneration = pendingOAuthIdentityGeneration(pendingGeneration);
  const stateAge = Date.now() - stateIssuedAt;
  const stateFresh = Number.isSafeInteger(stateIssuedAt) &&
    stateIssuedAt > 0 &&
    stateAge >= 0 &&
    stateAge <= OAUTH_STATE_TTL_MS;
  if (
    !oauthStateMatches(state, expectedState) ||
    !stateFresh ||
    !identityGeneration ||
    identityGeneration !== getOAuthIdentityGeneration()
  ) {
    return res.send(callbackHtml('Invalid state parameter — possible CSRF attack', false));
  }

  const stateConsumed = await withAccountOperation(() =>
    setSettingsAtomicallyIfCurrent(
      [
        ['oauth_state', expectedState],
        ['oauth_state_issued_at', expectedStateIssuedAt],
        ['oauth_state_generation', pendingGeneration],
        ['oauth_identity_generation', identityGeneration],
      ],
      [
        ['oauth_state', ''],
        ['oauth_state_issued_at', '0'],
      ],
    ),
  );
  if (!stateConsumed) {
    return res.send(callbackHtml('Authorization state is no longer current.', false));
  }

  let authorizationStored = false;
  try {
    if (oauthError) {
      return res.send(callbackHtml('Authorization was not completed.', false));
    }
    if (typeof code !== 'string' || !code || code.length > 4096) {
      return res.send(callbackHtml('No authorization code received', false));
    }

    const clientId = getSetting('oauth_client_id');
    const clientSecretEncrypted = getSetting('oauth_client_secret_encrypted') || '';
    const clientSecret = decrypt(clientSecretEncrypted);
    if (!clientId || !clientSecret) {
      return res.send(callbackHtml('OAuth app credentials missing. Please save them first.', false));
    }

    let redirectUri;
    try {
      redirectUri = resolveOAuthRedirectUri(req);
    } catch (error) {
      console.error('[OAuth] Public origin configuration invalid', safeErrorMetadata(error));
      return res.status(503).send(callbackHtml(
        'Public URL configuration is invalid. Update the server configuration and retry.',
        false,
      ));
    }

    // Exchange code for tokens
    const tokenRes = await fetchOAuth(TOKEN_URL, {
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
      await tokenRes.text().catch(() => '');
      console.error('[OAuth] Token exchange failed:', tokenRes.status);
      return res.send(callbackHtml('Authorization could not be completed. Please retry.', false));
    }

    const tokenData = await tokenRes.json();
    if (
      typeof tokenData?.access_token !== 'string' ||
      !tokenData.access_token ||
      typeof tokenData?.refresh_token !== 'string' ||
      !tokenData.refresh_token ||
      !Number.isFinite(Number(tokenData?.expires_in)) ||
      Number(tokenData.expires_in) <= 0
    ) {
      console.error('[OAuth] Token exchange returned an invalid response');
      return res.send(callbackHtml('Authorization could not be completed. Please retry.', false));
    }

    // Fetch the authorized companies, but require a separate explicit selection.
    const userRes = await fetchOAuth('https://api.freee.co.jp/hr/api/v1/users/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      await userRes.text().catch(() => '');
      console.error('[OAuth] Authorized company lookup failed:', userRes.status);
      return res.send(callbackHtml(
        'Authorization succeeded, but the company list could not be confirmed. Please retry.',
        false,
      ));
    }

    const userData = await userRes.json();
    const rawCompanies = Array.isArray(userData?.companies) ? userData.companies : [];
    const companyIds = new Set();
    const companyListConfirmed = rawCompanies.length > 0 && rawCompanies.every((company) => {
      if (!company || typeof company !== 'object') return false;
      const companyId = normalizeOAuthId(company.id);
      const employeeId = normalizeOAuthId(company.employee_id);
      if (!companyId || !employeeId || companyIds.has(companyId)) return false;
      companyIds.add(companyId);
      return true;
    });
    if (!companyListConfirmed) {
      return res.send(callbackHtml(
        'Authorization succeeded, but the company list could not be confirmed. Please retry.',
        false,
      ));
    }
    const companies = rawCompanies.map((company) => {
      const companyId = normalizeOAuthId(company.id);
      return {
        id: company.id,
        employee_id: company.employee_id,
        name: typeof company.name === 'string' && company.name
          ? company.name
          : `Company ${companyId}`,
        display_name: typeof company.display_name === 'string'
          ? company.display_name
          : '',
      };
    });

    const tokenExpiresAt =
      Math.floor(Date.now() / 1000) + Math.floor(Number(tokenData.expires_in));
    const stored = await mutateAutomationConfiguration(() => {
      const nextGeneration = nextIdentityGeneration('oauth_identity_generation');
      return setSettingsAtomicallyIfCurrent(
        [
          ['oauth_state', ''],
          ['oauth_state_generation', pendingGeneration],
          ['oauth_identity_generation', identityGeneration],
          ['oauth_client_id', clientId],
          ['oauth_client_secret_encrypted', clientSecretEncrypted],
        ],
        [
          ['oauth_access_token_encrypted', encrypt(tokenData.access_token)],
          ['oauth_refresh_token_encrypted', encrypt(tokenData.refresh_token)],
          ['oauth_token_expires_at', String(tokenExpiresAt)],
          ...clearedOAuthCompanyEntries(),
          ['oauth_companies', JSON.stringify(companies)],
          ['oauth_user_display_name',
            typeof userData?.display_name === 'string' ? userData.display_name : ''],
          ['oauth_user_id', ''],
          ['oauth_user_email', ''],
          ['oauth_auth_broken', '0'],
          ['oauth_auth_broken_since', ''],
          ['oauth_auth_broken_reason', ''],
          ['oauth_state_generation', ''],
          ['oauth_identity_generation', nextGeneration],
        ],
      );
    });
    if (!stored) {
      return res.send(callbackHtml(
        'OAuth configuration changed before authorization completed. Please retry.',
        false,
      ));
    }

    authorizationStored = true;
    console.log(`[OAuth] Authorization completed; ${companies.length} company selection(s) available`);
    return res.send(callbackHtml('Authorization successful. Select a company to continue.', true));
  } catch (e) {
    console.error('[OAuth] Callback error', safeErrorMetadata(e));
    return res.send(callbackHtml('Authorization could not be completed. Please retry.', false));
  } finally {
    if (!authorizationStored) {
      await clearPendingOAuthAuthorization(pendingGeneration, identityGeneration).catch((error) => {
        console.error('[OAuth] Pending authorization cleanup failed', safeErrorMetadata(error));
      });
    }
  }
});

/**
 * GET /api/config/oauth-status - Get OAuth configuration status
 */
router.get('/oauth-status', (req, res) => {
  const configured = isOAuthReady();
  const clientId = getSetting('oauth_client_id') || '';
  const identity = configured ? assertOAuthCompanyIdentity() : null;
  const companyId = identity?.companyId || '';
  const employeeId = identity?.employeeId || '';
  const companyName = identity?.companyName || '';
  const expiresAt = parseInt(getSetting('oauth_token_expires_at') || '0', 10);
  const userDisplayName = getSetting('oauth_user_display_name') || '';
  const employeeNum = configured ? getSetting('oauth_employee_num') || '' : '';
  const authBroken = getSetting('oauth_auth_broken') === '1';
  const companies = getAuthorizedOAuthCompanies();
  const hasTokenGeneration = Boolean(
    getSetting('oauth_access_token_encrypted') &&
    getSetting('oauth_refresh_token_encrypted'),
  );

  // If display_name is empty, try to get it from the selected company's data
  let resolvedDisplayName = userDisplayName;
  if (!resolvedDisplayName && companyId && companies.length > 0) {
    const selectedCompanies = companies.filter(
      (company) => normalizeOAuthId(company.id) === normalizeOAuthId(companyId),
    );
    if (selectedCompanies.length === 1 && selectedCompanies[0].display_name) {
      resolvedDisplayName = selectedCompanies[0].display_name;
    }
  }

  res.json({
    configured,
    authorization_version: getOAuthIdentityGeneration(),
    client_id_masked: clientId ? clientId.slice(0, 8) + '...' : '',
    company_id: companyId,
    employee_id: employeeId,
    company_name: companyName,
    companies,
    needs_company_selection: hasTokenGeneration && companies.length > 0 && !configured,
    user_display_name: resolvedDisplayName,
    employee_num: employeeNum,
    token_expires_at: expiresAt,
    token_valid: !authBroken && expiresAt > Math.floor(Date.now() / 1000),
    auth_broken: authBroken,
    auth_broken_since: getSetting('oauth_auth_broken_since') || '',
    auth_broken_reason: getSetting('oauth_auth_broken_reason') || '',
  });
});

/**
 * PUT /api/config/oauth-select-company - Select which company to use (for multi-company accounts)
 */
router.put('/oauth-select-company', async (req, res) => {
  const { company_id } = req.body || {};
  const requestedCompanyId = normalizeOAuthId(company_id);
  if (!requestedCompanyId) {
    return res.status(400).json({ error: 'company_id is required' });
  }

  scheduler.stopAll();
  try {
  const selection = await withAccountOperation(() => {
    const companies = getAuthorizedOAuthCompanies();
    const selectedCompanies = companies.filter(
      (company) => normalizeOAuthId(company.id) === requestedCompanyId,
    );
    if (selectedCompanies.length === 0) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Company not found in authorized companies' },
      };
    }
    if (selectedCompanies.length !== 1) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'The authorized company identity is invalid.',
          code: FREEE_AUTH_ERROR_CODES.COMPANY_SELECTION_INVALID,
        },
      };
    }
    const [selected] = selectedCompanies;

    const cid = normalizeOAuthId(selected.id);
    const eid = normalizeOAuthId(selected.employee_id);
    if (!cid || !eid) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'The selected company has no valid employee identity.',
          code: FREEE_AUTH_ERROR_CODES.COMPANY_SELECTION_INVALID,
        },
      };
    }
    if (
      !getSetting('oauth_access_token_encrypted') ||
      !getSetting('oauth_refresh_token_encrypted')
    ) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'Complete OAuth authorization before selecting a company.',
          code: 'OAUTH_AUTHORIZATION_REQUIRED',
        },
      };
    }

    const companyName = selected.name || '';
    const generation = nextIdentityGeneration('oauth_identity_generation');
    setSettingsAtomically([
      ['oauth_company_id', cid],
      ['oauth_employee_id', eid],
      ['oauth_company_name', companyName],
      ['oauth_employee_num', ''],
      ['oauth_user_display_name', selected.display_name || ''],
      ['oauth_configured', '1'],
      ['oauth_identity_generation', generation],
    ]);
    return {
      ok: true,
      cid,
      eid,
      companyName,
      generation,
      identityBinding: Object.freeze({
        companyId: cid,
        employeeId: eid,
        companyName,
        generation,
      }),
    };
  });
  if (!selection.ok) {
    return res.status(selection.status).json(selection.body);
  }
  const {
    cid,
    eid,
    companyName,
    generation,
    identityBinding,
  } = selection;

  // Fetch employee details to get employee number and display name
  let employeeNum = '';
  try {
    const client = new FreeeApiClient({ identityBinding });
    const empData = await client.apiRequest(
      'GET',
      `/employees/${eid}?company_id=${cid}`,
    );
    employeeNum = typeof empData?.num === 'string' ? empData.num : '';
    const updates = [['oauth_employee_num', employeeNum]];
    if (typeof empData?.display_name === 'string' && empData.display_name) {
      updates.push(['oauth_user_display_name', empData.display_name]);
    }
    const selectionStillCurrent = setSettingsAtomicallyIfCurrent(
      [
        ['oauth_company_id', cid],
        ['oauth_employee_id', eid],
        ['oauth_configured', '1'],
        ['oauth_identity_generation', generation],
      ],
      updates,
    );
    if (!selectionStillCurrent) {
      return res.status(409).json({
        error: 'The OAuth company selection changed while it was being verified.',
        code: 'OAUTH_COMPANY_SELECTION_CHANGED',
      });
    }
  } catch (e) {
    if (e?.code === FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED) {
      return res.status(409).json({
        error: 'The OAuth company selection changed while it was being verified.',
        code: 'OAUTH_COMPANY_SELECTION_CHANGED',
      });
    }
    console.log('[OAuth] Could not fetch employee details', safeErrorMetadata(e));
  }

  try {
    assertOAuthIdentityBinding(identityBinding);
    assertOAuthCompanyIdentity({ id: cid, employee_id: eid, name: companyName });
  } catch {
    return res.status(409).json({
      error: 'The OAuth company selection changed while it was being verified.',
      code: 'OAUTH_COMPANY_SELECTION_CHANGED',
    });
  }

  console.log('[OAuth] Company selection saved');

  return res.json({
    success: true,
    company_id: cid,
    employee_id: eid,
    company_name: companyName,
    employee_num: employeeNum,
  });
  } finally {
    try {
      await scheduler.initialize();
      console.log('[OAuth] Scheduler re-initialized after company selection');
    } catch (error) {
      console.warn('[OAuth] Scheduler re-init failed', safeErrorMetadata(error));
    }
  }
});

/**
 * POST /api/config/oauth-verify - Verify OAuth API connection
 */
router.post('/oauth-verify', async (req, res) => {
  const result = await runOAuthVerify();
  return res.status(result.status).json(result.body);
});

/**
 * DELETE /api/config/oauth - Clear all OAuth data
 */
router.delete('/oauth', async (req, res) => {
  await mutateAutomationConfiguration(() => {
    const generation = nextIdentityGeneration('oauth_identity_generation');
    return setSettingsAtomically([
    ['oauth_client_id', ''],
    ['oauth_client_secret_encrypted', ''],
    ['oauth_access_token_encrypted', ''],
    ['oauth_refresh_token_encrypted', ''],
    ['oauth_token_expires_at', '0'],
    ['oauth_state', ''],
    ['oauth_state_issued_at', '0'],
    ['oauth_state_generation', ''],
    ['oauth_identity_generation', generation],
    ...clearedOAuthCompanyEntries(),
    ['oauth_auth_broken', '0'],
    ['oauth_auth_broken_since', ''],
    ['oauth_auth_broken_reason', ''],
    ]);
  });

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
  return `<!DOCTYPE html>
<html><head><title>PunchPilot OAuth</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
  .card { background: white; border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  .msg { font-size: 16px; color: #333; margin-bottom: 16px; }
  .hint { font-size: 13px; color: #888; }
</style></head>
<body data-oauth-result="${success ? 'success' : 'error'}"><div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <div class="msg">${safeMessage}</div>
  <div class="hint">This window will close automatically...</div>
</div>
<script src="/oauth-callback.js" defer></script>
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

  const { mode, fixed_time, window_start, window_end, enabled } = req.body || {};

  // Validate mode
  if (mode !== undefined && (typeof mode !== 'string' || !['fixed', 'random'].includes(mode))) {
    return res.status(400).json({ error: 'Mode must be "fixed" or "random"' });
  }

  // Validate time formats
  if (fixed_time !== undefined && (typeof fixed_time !== 'string' || !isTimeString(fixed_time))) {
    return res.status(400).json({ error: 'fixed_time must be in HH:MM format' });
  }
  if (window_start !== undefined && (typeof window_start !== 'string' || !isTimeString(window_start))) {
    return res.status(400).json({ error: 'window_start must be in HH:MM format' });
  }
  if (window_end !== undefined && (typeof window_end !== 'string' || !isTimeString(window_end))) {
    return res.status(400).json({ error: 'window_end must be in HH:MM format' });
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
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

  if (actionType === 'break_end' || actionType === 'break_start') {
    const effective = (action) => ({ ...getConfigByAction(action), ...(action === actionType
      ? Object.fromEntries(Object.entries({ mode, fixed_time, window_start, window_end, enabled }).filter(([, value]) => value !== undefined)) : {}) });
    const start = effective('break_start');
    const end = effective('break_end');
    if (start.enabled && end.enabled && !resolveBreakTimes(start, end, {}, () => 0)) {
      return res.status(400).json({ error: 'Break windows must allow at least 60 minutes and at most 90 minutes' });
    }
  }

  // Build update data
  const data = {};
  if (mode !== undefined) data.mode = mode;
  if (fixed_time !== undefined) data.fixed_time = fixed_time;
  if (window_start !== undefined) data.window_start = window_start;
  if (window_end !== undefined) data.window_end = window_end;
  if (enabled !== undefined) data.enabled = enabled ? 1 : 0;

  await mutateAutomationConfiguration(() => updateConfig(actionType, data), { skipPastNewTimes: true });

  const updated = getConfigByAction(actionType);
  res.json(updated);
});

export default router;
