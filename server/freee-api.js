/**
 * freee HR API client with OAuth2 token management.
 * Provides attendance (打刻) operations via the freee HR API
 * instead of Playwright browser automation.
 */


import {
  getSetting,
  setSetting,
  setSettingsAtomically,
  setSettingsAtomicallyIfCurrent,
} from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { FREEE_ERROR_MESSAGES, FREEE_STATE } from './constants.js';
import { todayStringInTz, getTimezone } from './timezone.js';
import { parseExternalId } from './freee-values.js';
import { isDateString, partsInTimezone, minutesToTime } from '../shared/date-time.js';
import { getOAuthIdentityGeneration } from './automation/identity.js';

const API_BASE = 'https://api.freee.co.jp/hr/api/v1';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const FETCH_TIMEOUT_MS = 30_000;

export const FREEE_AUTH_ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_TRANSIENT: 'AUTH_TRANSIENT',
  COMPANY_SELECTION_REQUIRED: 'OAUTH_COMPANY_SELECTION_REQUIRED',
  COMPANY_SELECTION_INVALID: 'OAUTH_COMPANY_SELECTION_INVALID',
  COMPANY_IDENTITY_MISMATCH: 'OAUTH_COMPANY_IDENTITY_MISMATCH',
  IDENTITY_CHANGED: 'OAUTH_IDENTITY_CHANGED',
};

export const FREEE_API_ERROR_CODES = {
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  API_TRANSIENT: 'API_TRANSIENT',
  API_RESPONSE_UNCONFIRMED: 'API_RESPONSE_UNCONFIRMED',
  ATTENDANCE_BASE_DATE_MISMATCH: 'ATTENDANCE_BASE_DATE_MISMATCH',
  DIRECT_EDIT_DISABLED: 'DIRECT_EDIT_DISABLED',
  MONTHLY_CLOSING_ALREADY_SUBMITTED: 'MONTHLY_CLOSING_ALREADY_SUBMITTED',
  WEB_ONLY_LEAVE_COMBINATION: 'WEB_ONLY_LEAVE_COMBINATION',
  WEB_FORM_REQUIRED: 'WEB_FORM_REQUIRED',
};

// Map internal action types to freee API clock types
const ACTION_TO_CLOCK_TYPE = {
  checkin: 'clock_in',
  checkout: 'clock_out',
  break_start: 'break_begin',
  break_end: 'break_end',
};

function createFreeeError(message, code, cause = null) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

const AVAILABLE_CLOCK_TYPES = new Set([
  'clock_in',
  'break_begin',
  'break_end',
  'clock_out',
]);

export function parseAvailableClockTypesResponse(
  data,
  expectedBaseDate = todayStringInTz(),
) {
  const responseIsObject =
    data && typeof data === 'object' && !Array.isArray(data);
  const availableTypes = responseIsObject ? data.available_types : null;
  const baseDate = responseIsObject ? data.base_date : null;
  const typesAreValid =
    Array.isArray(availableTypes) &&
    availableTypes.every((type) => AVAILABLE_CLOCK_TYPES.has(type)) &&
    new Set(availableTypes).size === availableTypes.length;
  if (
    !typesAreValid ||
    typeof baseDate !== 'string' ||
    !isDateString(baseDate)
  ) {
    throw createFreeeError(
      'freee attendance state response could not be confirmed.',
      FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED,
    );
  }
  if (baseDate !== expectedBaseDate) {
    throw createFreeeError(
      'A cross-day freee attendance occurrence requires manual confirmation.',
      FREEE_API_ERROR_CODES.ATTENDANCE_BASE_DATE_MISMATCH,
    );
  }

  const types = new Set(availableTypes);
  let state = FREEE_STATE.UNKNOWN;
  if (types.size === 0) {
    state = FREEE_STATE.CHECKED_OUT;
  } else if (
    types.has('break_end') &&
    !types.has('clock_in') &&
    !types.has('break_begin')
  ) {
    state = FREEE_STATE.ON_BREAK;
  } else if (
    !types.has('break_end') &&
    !types.has('clock_in') &&
    (types.has('clock_out') || types.has('break_begin'))
  ) {
    state = FREEE_STATE.WORKING;
  } else if (types.size === 1 && types.has('clock_in')) {
    state = FREEE_STATE.NOT_CHECKED_IN;
  }

  if (state === FREEE_STATE.UNKNOWN) {
    throw createFreeeError(
      'freee attendance state response could not be confirmed.',
      FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED,
    );
  }
  return Object.freeze({
    state,
    baseDate,
    availableTypes: Object.freeze([...availableTypes]),
  });
}

function normalizeOAuthId(value) {
  const id = parseExternalId(value);
  return id == null ? '' : String(id);
}

export function parseCreatedClockResponse(data, type, date) {
  const record = data?.employee_time_clock;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !parseExternalId(record.id) || record.type !== type || record.date !== date) {
    throw createFreeeError('The clock write may have succeeded; check freee before retrying.',
      FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
  }
  return record;
}

export function getAuthorizedOAuthCompanies() {
  try {
    const companies = JSON.parse(getSetting('oauth_companies') || '[]');
    if (!Array.isArray(companies)) return [];
    return companies
      .filter((company) => company && typeof company === 'object')
      .map((company) => ({
        id: company.id,
        employee_id: company.employee_id,
        name: typeof company.name === 'string' ? company.name : '',
        display_name: typeof company.display_name === 'string' ? company.display_name : '',
      }));
  } catch {
    return [];
  }
}

export function assertOAuthCompanyIdentity(actualIdentity = null) {
  const companyId = normalizeOAuthId(getSetting('oauth_company_id'));
  const employeeId = normalizeOAuthId(getSetting('oauth_employee_id'));
  if (!companyId || !employeeId) {
    throw createFreeeError(
      'Select a valid authorized company before using the freee API.',
      FREEE_AUTH_ERROR_CODES.COMPANY_SELECTION_REQUIRED,
    );
  }

  const selectedCompanies = getAuthorizedOAuthCompanies().filter(
    (company) => normalizeOAuthId(company.id) === companyId,
  );
  if (
    selectedCompanies.length !== 1 ||
    normalizeOAuthId(selectedCompanies[0].employee_id) !== employeeId
  ) {
    throw createFreeeError(
      'The stored freee company selection is no longer authorized.',
      FREEE_AUTH_ERROR_CODES.COMPANY_SELECTION_INVALID,
    );
  }
  const [selectedCompany] = selectedCompanies;

  const companyName = selectedCompany.name.trim();
  if (actualIdentity !== null) {
    if (!actualIdentity || typeof actualIdentity !== 'object') {
      throw createFreeeError(
        'The freee company identity could not be confirmed.',
        FREEE_AUTH_ERROR_CODES.COMPANY_IDENTITY_MISMATCH,
      );
    }

    const actualCompanyId = actualIdentity.id ?? actualIdentity.company_id ?? actualIdentity.companyId;
    const actualEmployeeId =
      actualIdentity.employee_id ?? actualIdentity.employeeId;
    const actualCompanyName =
      actualIdentity.name ?? actualIdentity.company_name ?? actualIdentity.companyName;
    let asserted = false;
    let matches = true;

    if (actualCompanyId !== undefined) {
      asserted = true;
      matches &&= normalizeOAuthId(actualCompanyId) === companyId;
    }
    if (actualEmployeeId !== undefined) {
      asserted = true;
      matches &&= normalizeOAuthId(actualEmployeeId) === employeeId;
    }
    if (actualCompanyName !== undefined) {
      asserted = true;
      matches &&=
        typeof actualCompanyName === 'string' && actualCompanyName.trim() === companyName;
    }
    if (!asserted || !matches) {
      throw createFreeeError(
        'The active freee company does not match the selected OAuth company.',
        FREEE_AUTH_ERROR_CODES.COMPANY_IDENTITY_MISMATCH,
      );
    }
  }

  return { companyId, employeeId, companyName };
}

export function captureOAuthIdentityBinding() {
  const identity = assertOAuthCompanyIdentity();
  return Object.freeze({
    ...identity,
    generation: getOAuthIdentityGeneration(),
  });
}

export function assertOAuthIdentityBinding(binding) {
  const current = captureOAuthIdentityBinding();
  if (
    !binding ||
    binding.generation !== current.generation ||
    binding.companyId !== current.companyId ||
    binding.employeeId !== current.employeeId ||
    binding.companyName !== current.companyName
  ) {
    throw createFreeeError(
      'The selected freee OAuth identity changed during the operation.',
      FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
    );
  }
  return current;
}

export function isOAuthReady() {
  if (getSetting('oauth_configured') !== '1') return false;
  try {
    assertOAuthCompanyIdentity();
    return true;
  } catch {
    return false;
  }
}

function upstreamMessage(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.errors?.[0]?.messages?.[0] || parsed?.message;
    return typeof message === 'string' ? message : '';
  } catch {
    return '';
  }
}

function classifyApiFailure(status, body, path) {
  const message = upstreamMessage(body);
  const requestPath = String(path).split('?', 1)[0];
  const isApprovalRequest = requestPath.startsWith('/approval_requests/');
  const isWorkRecord = requestPath.includes('/work_records/');

  if (
    requestPath === '/approval_requests/monthly_attendances' &&
    message.includes(FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED)
  ) {
    return {
      code: FREEE_API_ERROR_CODES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
      message: FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
    };
  }
  if (
    (isApprovalRequest || isWorkRecord) &&
    message.includes('特別休暇') &&
    message.includes('Webで確認してください')
  ) {
    return {
      code: FREEE_API_ERROR_CODES.WEB_ONLY_LEAVE_COMBINATION,
      message: 'This leave combination must be confirmed in freee Web.',
    };
  }
  if (
    isApprovalRequest &&
    (message.includes('役職') ||
      message.includes('部門') ||
      message.includes('Webから申請'))
  ) {
    return {
      code: FREEE_API_ERROR_CODES.WEB_FORM_REQUIRED,
      message: 'This approval request must be submitted through freee Web.',
    };
  }
  if (
    isWorkRecord &&
    message.includes('勤怠修正') &&
    (message.includes('無効') || message.includes('許可されていません'))
  ) {
    return {
      code: FREEE_API_ERROR_CODES.DIRECT_EDIT_DISABLED,
      message: 'Direct work-record editing is disabled for this company.',
    };
  }
  if (status === 403) {
    return {
      code: FREEE_API_ERROR_CODES.PERMISSION_DENIED,
      message: 'freee API permission denied (HTTP 403).',
    };
  }
  if (status === 429) {
    return {
      code: FREEE_API_ERROR_CODES.RATE_LIMITED,
      message: 'freee API rate limit reached (HTTP 429).',
    };
  }
  if (status >= 500) {
    return {
      code: FREEE_API_ERROR_CODES.API_TRANSIENT,
      message: `freee API is temporarily unavailable (HTTP ${status}).`,
    };
  }
  return {
    code: `API_ERROR_${status}`,
    message: `freee API request failed (HTTP ${status}).`,
  };
}

function safeApiPath(rawPath) {
  return String(rawPath)
    .split('?', 1)[0]
    .replace(/\/employees\/[^/]+/g, '/employees/:employee')
    .replace(/\/work_records\/[^/]+/g, '/work_records/:date')
    .replace(/\/time_clocks\/[^/]+/g, '/time_clocks/:record')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

function nowString() {
  return new Date().toISOString();
}

function authBreakerEntries(reason = '') {
  return reason
    ? [
        ['oauth_auth_broken', '1'],
        ['oauth_auth_broken_since', nowString()],
        ['oauth_auth_broken_reason', reason],
      ]
    : [
        ['oauth_auth_broken', '0'],
        ['oauth_auth_broken_since', ''],
        ['oauth_auth_broken_reason', ''],
      ];
}

export function isOAuthAuthBroken() {
  return getSetting('oauth_auth_broken') === '1';
}

export function clearOAuthAuthBroken() {
  setSettingsAtomically(authBreakerEntries());
}

async function fetchWithTimeout(url, options = {}) {
  if (
    options.signal ||
    typeof AbortSignal === 'undefined' ||
    typeof AbortSignal.timeout !== 'function'
  ) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

let tokenRefreshFlight = null;

function readOAuthTokenState() {
  return {
    accessTokenEncrypted: getSetting('oauth_access_token_encrypted') || '',
    refreshTokenEncrypted: getSetting('oauth_refresh_token_encrypted') || '',
    expiresAt: Number.parseInt(getSetting('oauth_token_expires_at') || '0', 10),
    authBroken: getSetting('oauth_auth_broken') === '1',
    authBrokenReason: getSetting('oauth_auth_broken_reason') || '',
  };
}

function usableAccessToken(state) {
  const now = Math.floor(Date.now() / 1000);
  if (!state.accessTokenEncrypted || now >= state.expiresAt - 300) return '';
  return decrypt(state.accessTokenEncrypted) || '';
}

function tokenEndpointErrorCode(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error === 'string' ? parsed.error : '';
  } catch {
    return body.trim() === 'invalid_grant' ? 'invalid_grant' : '';
  }
}

function markRefreshGenerationBroken(refreshTokenEncrypted, reason) {
  return setSettingsAtomicallyIfCurrent(
    [['oauth_refresh_token_encrypted', refreshTokenEncrypted]],
    authBreakerEntries(reason),
  );
}

function markOAuthBindingBroken(binding, reason) {
  if (!binding) return false;
  return setSettingsAtomicallyIfCurrent(
    [
      ['oauth_identity_generation', binding.generation],
      ['oauth_company_id', binding.companyId],
      ['oauth_employee_id', binding.employeeId],
    ],
    authBreakerEntries(
      reason || 'OAuth authorization requires re-authorization.',
    ),
  );
}

async function refreshTokenGeneration(expectedGeneration) {
  const state = readOAuthTokenState();
  if (state.refreshTokenEncrypted !== expectedGeneration) return;

  console.log('[API] Access token expired or expiring soon, refreshing...');
  const refreshToken = decrypt(state.refreshTokenEncrypted);
  if (!refreshToken) {
    const message = 'No refresh token available. Please re-authorize in Settings.';
    markRefreshGenerationBroken(expectedGeneration, message);
    throw createFreeeError(message, FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED);
  }

  const clientId = getSetting('oauth_client_id');
  const clientSecret = decrypt(getSetting('oauth_client_secret_encrypted'));
  if (!clientId || !clientSecret) {
    const message = 'OAuth app credentials not configured. Go to Settings -> API Configuration.';
    markRefreshGenerationBroken(expectedGeneration, message);
    throw createFreeeError(message, FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED);
  }

  let response;
  try {
    response = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
  } catch (cause) {
    throw createFreeeError(
      'Token refresh request failed due to a network or timeout error.',
      FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT,
      cause,
    );
  }

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 4096);
    console.error(`[API] Token refresh failed: ${response.status}`);
    const message = `Token refresh failed (${response.status}). Please re-authorize in Settings.`;
    if (tokenEndpointErrorCode(errorBody) === 'invalid_grant') {
      const markedCurrentGeneration = markRefreshGenerationBroken(expectedGeneration, message);
      if (!markedCurrentGeneration) return;
    }
    const code = response.status >= 400 && response.status < 500
      ? FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED
      : FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT;
    throw createFreeeError(message, code);
  }

  let data;
  try {
    data = await response.json();
  } catch (cause) {
    throw createFreeeError(
      'Token refresh returned an invalid response.',
      FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT,
      cause,
    );
  }
  const expiresIn = Number(data?.expires_in);
  if (
    typeof data?.access_token !== 'string' ||
    !data.access_token ||
    typeof data?.refresh_token !== 'string' ||
    !data.refresh_token ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw createFreeeError(
      'Token refresh returned an invalid response.',
      FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT,
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(expiresIn);
  const written = setSettingsAtomicallyIfCurrent(
    [['oauth_refresh_token_encrypted', expectedGeneration]],
    [
      ['oauth_access_token_encrypted', encrypt(data.access_token)],
      ['oauth_refresh_token_encrypted', encrypt(data.refresh_token)],
      ['oauth_token_expires_at', String(expiresAt)],
      ...authBreakerEntries(),
    ],
  );
  if (written) {
    console.log(`[API] Token refreshed, expires in ${Math.floor(expiresIn)}s`);
  }
}

export class FreeeApiClient {
  constructor({ identityBinding = null } = {}) {
    this.companyId = '';
    this.employeeId = '';
    this.identityBinding = identityBinding
      ? Object.freeze({ ...assertOAuthIdentityBinding(identityBinding) })
      : null;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * Call this before every API request.
   */
  async ensureValidToken() {
    while (true) {
      if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
      const state = readOAuthTokenState();
      if (state.authBroken) {
        const reason = state.authBrokenReason || 'OAuth authorization requires re-authorization.';
        throw createFreeeError(reason, FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED);
      }

      const accessToken = usableAccessToken(state);
      if (accessToken) return accessToken;

      let flight = tokenRefreshFlight;
      if (!flight) {
        flight = {
          generation: state.refreshTokenEncrypted,
          promise: refreshTokenGeneration(state.refreshTokenEncrypted),
        };
        tokenRefreshFlight = flight;
      }

      try {
        await flight.promise;
        if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
      } catch (error) {
        const latestState = readOAuthTokenState();
        if (latestState.refreshTokenEncrypted !== flight.generation) continue;
        throw error;
      } finally {
        if (tokenRefreshFlight === flight) tokenRefreshFlight = null;
      }
    }
  }

  /**
   * Make an authenticated API request.
   * On 401, forces a token refresh and retries once before failing.
   */
  async apiRequest(
    method,
    path,
    body = null,
    {
      retry = false,
      beforeDispatch = null,
      beforeDispatchAsync = null,
      expectedStatus = null,
    } = {},
  ) {
    await this.ensureUserInfo();

    const token = await this.ensureValidToken();
    if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const url = `${API_BASE}${path}`;
    const logPath = safeApiPath(path);
    if (beforeDispatchAsync !== null) {
      if (typeof beforeDispatchAsync !== 'function') {
        const error = new Error('The asynchronous API dispatch guard is invalid.');
        error.code = 'API_DISPATCH_GUARD_INVALID';
        throw error;
      }
      await beforeDispatchAsync();
      if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
    }
    if (typeof beforeDispatch === 'function') {
      const authorization = beforeDispatch();
      if (authorization && typeof authorization.then === 'function') {
        const error = new Error('The API dispatch guard must be synchronous.');
        error.code = 'API_DISPATCH_GUARD_ASYNC_UNSUPPORTED';
        throw error;
      }
    }
    console.log(`[API] ${method} ${logPath}`);

    let response;
    try {
      response = await fetchWithTimeout(url, options);
    } catch (cause) {
      throw createFreeeError(
        'freee API request failed due to a network or timeout error.',
        FREEE_API_ERROR_CODES.API_TRANSIENT,
        cause,
      );
    }

    if (this.identityBinding) {
      assertOAuthIdentityBinding(this.identityBinding);
    }

    if (!response.ok) {
      const errBody = (await response.text()).slice(0, 4096);
      assertOAuthIdentityBinding(this.identityBinding);
      console.error(`[API] ${method} ${logPath} -> ${response.status}`);

      // On 401 (first attempt only): force token refresh and retry once.
      // This handles cases where the stored token is invalidated server-side
      // (e.g., revoked, or stale after Docker rebuild) but the local expiry
      // timestamp hasn't passed yet.
      if (response.status === 401 && !retry) {
        console.log('[API] 401 received, forcing token refresh and retrying...');
        if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
        this.forceTokenRefresh();
        return this.apiRequest(method, path, body, {
          retry: true,
          beforeDispatch,
          beforeDispatchAsync,
          expectedStatus,
        });
      }

      if (response.status === 401) {
        const message = 'Authorization expired or revoked. Please re-authorize in Settings.';
        if (!markOAuthBindingBroken(this.identityBinding, message)) {
          throw createFreeeError(
            'The selected freee OAuth identity changed during the operation.',
            FREEE_AUTH_ERROR_CODES.IDENTITY_CHANGED,
          );
        }
        throw createFreeeError(message, FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED);
      }
      const failure = classifyApiFailure(response.status, errBody, path);
      throw createFreeeError(failure.message, failure.code);
    }

    if (expectedStatus !== null && response.status !== expectedStatus) {
      throw createFreeeError('The API write result could not be confirmed; check freee before retrying.', FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
    }
    if (response.status === 204) {
      if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
      return null;
    }
    try {
      const data = await response.json();
      if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
      return data;
    } catch (cause) {
      if (this.identityBinding) assertOAuthIdentityBinding(this.identityBinding);
      throw createFreeeError(
        'freee API response could not be confirmed.',
        FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED,
        cause,
      );
    }
  }

  /**
   * Force the next ensureValidToken() call to refresh by expiring the cached timestamp.
   */
  forceTokenRefresh() {
    setSetting('oauth_token_expires_at', '0');
  }

  /**
   * Load only the explicitly selected, currently authorized company identity.
   */
  async ensureUserInfo() {
    const identity = this.identityBinding
      ? assertOAuthIdentityBinding(this.identityBinding)
      : captureOAuthIdentityBinding();
    if (!this.identityBinding) this.identityBinding = identity;
    this.companyId = identity.companyId;
    this.employeeId = identity.employeeId;
    return identity;
  }

  /**
   * Detect current attendance state by checking available clock types.
   * Returns one of FREEE_STATE.* values.
   */
  async detectStateSnapshot() {
    await this.ensureUserInfo();

    const data = await this.apiRequest(
      'GET',
      `/employees/${this.employeeId}/time_clocks/available_types?company_id=${this.companyId}`
    );

    const snapshot = parseAvailableClockTypesResponse(data);
    console.log(
      `[API] Available clock types: ${JSON.stringify(snapshot.availableTypes)}`,
    );
    return snapshot;
  }

  async detectState() {
    return (await this.detectStateSnapshot()).state;
  }

  /**
   * Execute a clock action via the API.
   * Returns a result object matching the shape from executeAction() in automation.js.
   */
  async executeClockAction(
    actionType,
    { mutationAuthorizationGuard = null } = {},
  ) {
    const clockType = ACTION_TO_CLOCK_TYPE[actionType];
    if (!clockType) {
      return {
        status: 'failure',
        screenshotBefore: null,
        screenshotAfter: null,
        durationMs: 0,
        error: `Unknown action type: ${actionType}`,
      };
    }

    const snapshot = await this.detectStateSnapshot();
    if (!snapshot.availableTypes.includes(clockType)) {
      throw createFreeeError(
        'The requested clock action is no longer available.',
        'ATTENDANCE_STATE_UNCONFIRMED',
      );
    }
    const baseDate = snapshot.baseDate;

    console.log(`[API] Posting clock action: ${clockType} for date ${baseDate}`);

    const created = await this.apiRequest(
      'POST',
      `/employees/${this.employeeId}/time_clocks`,
      {
        company_id: parseInt(this.companyId, 10),
        type: clockType,
        base_date: baseDate,
      },
      { beforeDispatch: mutationAuthorizationGuard, expectedStatus: 201 },
    );
    parseCreatedClockResponse(created, clockType, baseDate);

    console.log(`[API] Clock action ${clockType} succeeded`);

    // Detect state after action
    let postState;
    try {
      postState = await this.detectState();
    } catch {
      postState = FREEE_STATE.UNKNOWN;
    }

    return {
      status: 'success',
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 0, // Will be calculated by caller
      error: null,
      mock: false,
      detectedState: postState,
    };
  }

  /**
   * Fetch one daily work record from freee.
   * This is separate from time_clocks: approved leave/absence is reflected here.
   */
  async getWorkRecord(date = todayStringInTz()) {
    await this.ensureUserInfo();
    return this.apiRequest(
      'GET',
      `/employees/${this.employeeId}/work_records/${date}?company_id=${this.companyId}`
    );
  }

  // Map freee clock_type back to our internal action types
  static CLOCK_TYPE_TO_ACTION = {
    clock_in: 'checkin',
    clock_out: 'checkout',
    break_begin: 'break_start',
    break_end: 'break_end',
  };

  /**
   * Fetch today's time_clocks records from freee.
   * Returns an array of { type, datetime } sorted chronologically.
   * Each entry has:
   *   - type: 'checkin' | 'checkout' | 'break_start' | 'break_end'
   *   - time: 'HH:MM' (local time extracted from datetime)
   *   - datetime: full ISO datetime string from freee
   */
  async getTodayTimeClocks() {
    await this.ensureUserInfo();
    const today = todayStringInTz(); // YYYY-MM-DD

    const records = [];
    // The API defaults to the current payroll month and caps each page at 100.
    // A full page cannot be treated as complete history, even within one date.
    for (let offset = 0; ; offset += 100) {
      const data = await this.apiRequest('GET',
        `/employees/${this.employeeId}/time_clocks?company_id=${this.companyId}&from_date=${today}&to_date=${today}&limit=100&offset=${offset}`);
      if (!Array.isArray(data) || data.length > 100 || offset >= 1000) {
        throw createFreeeError('freee time clock history response could not be confirmed.', FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
      }
      records.push(...data);
      if (data.length < 100) break;
    }

    const todayClocks = [];

    for (const rec of records) {
      // Each record: { id, type, date, datetime, original_datetime, note }
      if (rec.date !== today) continue;

      const action = FreeeApiClient.CLOCK_TYPE_TO_ACTION[rec.type];
      if (!action) continue;

      if (typeof rec.datetime !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(rec.datetime) || !Number.isFinite(Date.parse(rec.datetime))) {
        throw createFreeeError('freee time clock timestamp could not be confirmed.', FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED);
      }
      const parts = partsInTimezone(new Date(rec.datetime), getTimezone());
      const time = minutesToTime(parts.hours * 60 + parts.minutes);

      todayClocks.push({ type: action, time, datetime: rec.datetime || '' });
    }

    // Ensure chronological order (defensive — freee may return newest-first)
    todayClocks.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
    return todayClocks;
  }

  /**
   * Verify the API connection by refreshing the token and calling /users/me.
   * Returns user info on success.
   */
  async verifyConnection() {
    const selectedIdentity = assertOAuthCompanyIdentity();
    await this.ensureValidToken();
    const data = await this.apiRequest('GET', '/users/me');
    const companies = Array.isArray(data?.companies)
      ? data.companies.filter(
          (candidate) => normalizeOAuthId(candidate?.id) === selectedIdentity.companyId,
        )
      : [];
    if (companies.length !== 1) {
      throw createFreeeError(
        'The selected company is not present in the current freee authorization.',
        FREEE_AUTH_ERROR_CODES.COMPANY_IDENTITY_MISMATCH,
      );
    }
    const [company] = companies;
    const confirmedIdentity = assertOAuthCompanyIdentity(company);
    return {
      company_id: confirmedIdentity.companyId,
      employee_id: confirmedIdentity.employeeId,
      display_name: data.display_name || '',
      email: data.email || '',
    };
  }
}
