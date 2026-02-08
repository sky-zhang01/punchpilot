/**
 * freee HR API client with OAuth2 token management.
 * Provides attendance (打刻) operations via the freee HR API
 * instead of Playwright browser automation.
 */

import chalk from 'chalk';
import { getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { FREEE_STATE } from './constants.js';
import { todayStringInTz } from './timezone.js';

const API_BASE = 'https://api.freee.co.jp/hr/api/v1';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

// Map internal action types to freee API clock types
const ACTION_TO_CLOCK_TYPE = {
  checkin: 'clock_in',
  checkout: 'clock_out',
  break_start: 'break_begin',
  break_end: 'break_end',
};

export class FreeeApiClient {
  constructor() {
    this.companyId = getSetting('oauth_company_id') || '';
    this.employeeId = getSetting('oauth_employee_id') || '';
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * Call this before every API request.
   */
  async ensureValidToken() {
    const expiresAt = parseInt(getSetting('oauth_token_expires_at') || '0', 10);
    const now = Math.floor(Date.now() / 1000);

    // Refresh 5 minutes before expiry
    if (now < expiresAt - 300) {
      return decrypt(getSetting('oauth_access_token_encrypted'));
    }

    console.log(chalk.blue('[API] Access token expired or expiring soon, refreshing...'));

    const refreshToken = decrypt(getSetting('oauth_refresh_token_encrypted'));
    if (!refreshToken) {
      throw new Error('No refresh token available. Please re-authorize in Settings.');
    }

    const clientId = getSetting('oauth_client_id');
    const clientSecret = decrypt(getSetting('oauth_client_secret_encrypted'));

    if (!clientId || !clientSecret) {
      throw new Error('OAuth app credentials not configured. Go to Settings → API Configuration.');
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(chalk.red(`[API] Token refresh failed: ${response.status} ${errBody}`));
      throw new Error(`Token refresh failed (${response.status}). Please re-authorize in Settings.`);
    }

    const data = await response.json();

    // Store new tokens (refresh token rotates with each refresh)
    setSetting('oauth_access_token_encrypted', encrypt(data.access_token));
    setSetting('oauth_refresh_token_encrypted', encrypt(data.refresh_token));
    setSetting('oauth_token_expires_at', String(Math.floor(Date.now() / 1000) + data.expires_in));

    console.log(chalk.green(`[API] Token refreshed, expires in ${data.expires_in}s`));
    return data.access_token;
  }

  /**
   * Make an authenticated API request.
   */
  async apiRequest(method, path, body = null) {
    const token = await this.ensureValidToken();

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
    console.log(chalk.blue(`[API] ${method} ${url}`));

    const response = await fetch(url, options);

    if (!response.ok) {
      const errBody = await response.text();
      console.error(chalk.red(`[API] ${method} ${path} → ${response.status}: ${errBody}`));

      // Parse freee error structure for better error messages
      let msg = errBody;
      try {
        const errJson = JSON.parse(errBody);
        msg = errJson?.errors?.[0]?.messages?.[0] || errJson?.message || errBody;
      } catch { /* use raw body */ }

      if (response.status === 401) throw new Error(`AUTH_EXPIRED: ${msg}`);
      if (response.status === 403) throw new Error(`PERMISSION_DENIED: ${msg}`);
      if (response.status === 429) throw new Error(`RATE_LIMITED: ${msg}`);
      throw new Error(`API_ERROR_${response.status}: ${msg}`);
    }

    return response.json();
  }

  /**
   * Fetch company_id and employee_id from /users/me if not already stored.
   */
  async ensureUserInfo() {
    if (this.companyId && this.employeeId) return;

    console.log(chalk.blue('[API] Fetching user info (company_id, employee_id)...'));
    const data = await this.apiRequest('GET', '/users/me');

    const company = data.companies?.[0];
    if (!company) {
      throw new Error('No company found for this user. Check your freee account permissions.');
    }

    this.companyId = String(company.id);
    this.employeeId = String(company.employee_id);

    setSetting('oauth_company_id', this.companyId);
    setSetting('oauth_employee_id', this.employeeId);

    console.log(chalk.green(`[API] User info: company=${this.companyId}, employee=${this.employeeId}`));
  }

  /**
   * Detect current attendance state by checking available clock types.
   * Returns one of FREEE_STATE.* values.
   */
  async detectState() {
    await this.ensureUserInfo();

    const data = await this.apiRequest(
      'GET',
      `/employees/${this.employeeId}/time_clocks/available_types?company_id=${this.companyId}`
    );

    const types = data.available_types || [];
    console.log(chalk.blue(`[API] Available clock types: ${JSON.stringify(types)}`));

    // Map available types to our state enum
    if (types.includes('break_end')) return FREEE_STATE.ON_BREAK;
    if (types.includes('clock_out') || types.includes('break_begin')) return FREEE_STATE.WORKING;
    if (types.includes('clock_in')) return FREEE_STATE.NOT_CHECKED_IN;
    return FREEE_STATE.CHECKED_OUT;
  }

  /**
   * Execute a clock action via the API.
   * Returns a result object matching the shape from executeAction() in automation.js.
   */
  async executeClockAction(actionType) {
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

    await this.ensureUserInfo();

    const baseDate = todayStringInTz(); // YYYY-MM-DD in configured timezone

    console.log(chalk.blue(`[API] Posting clock action: ${clockType} for date ${baseDate}`));

    const data = await this.apiRequest(
      'POST',
      `/employees/${this.employeeId}/time_clocks`,
      {
        company_id: parseInt(this.companyId, 10),
        type: clockType,
        base_date: baseDate,
      }
    );

    console.log(chalk.green(`[API] Clock action ${clockType} succeeded`));

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
      apiResponse: data,
    };
  }

  /**
   * Verify the API connection by refreshing the token and calling /users/me.
   * Returns user info on success.
   */
  async verifyConnection() {
    await this.ensureValidToken();
    const data = await this.apiRequest('GET', '/users/me');

    const company = data.companies?.[0];
    return {
      company_id: company?.id || null,
      employee_id: company?.employee_id || null,
      display_name: data.display_name || '',
      email: data.email || '',
    };
  }
}
