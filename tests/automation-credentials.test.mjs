import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSetting, initDatabase, setSetting } from '../server/db.js';
import { encrypt } from '../server/crypto.js';
import {
  getCredentials,
  hasApiCredentials,
  hasCredentials,
  hasWebCredentials,
  getWebCompanyName,
} from '../server/automation/utils.js';

const savedSettings = new Map();
const savedEnv = {
  LOGIN_USERNAME: process.env.LOGIN_USERNAME,
  LOGIN_PASSWORD: process.env.LOGIN_PASSWORD,
  FREEE_COMPANY_NAME: process.env.FREEE_COMPANY_NAME,
};

beforeEach(() => {
  initDatabase();
  for (const key of [
    'connection_mode',
    'oauth_configured',
    'freee_configured',
    'freee_username',
    'freee_username_encrypted',
    'freee_password_encrypted',
    'web_company_name',
    'oauth_company_name',
  ]) {
    savedSettings.set(key, getSetting(key));
  }
  setSetting('freee_configured', '0');
  setSetting('freee_username', '');
  setSetting('freee_username_encrypted', '');
  setSetting('freee_password_encrypted', '');
  setSetting('web_company_name', '');
  setSetting('oauth_company_name', '');
  delete process.env.LOGIN_USERNAME;
  delete process.env.LOGIN_PASSWORD;
  delete process.env.FREEE_COMPANY_NAME;
});

afterEach(() => {
  for (const [key, value] of savedSettings) {
    setSetting(key, value ?? '');
  }
  savedSettings.clear();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('transport-specific credential readiness', () => {
  it('decrypts the selected database account without using plaintext or environment credentials', () => {
    setSetting('freee_configured', '1');
    setSetting('freee_username', 'stale-plaintext-user');
    setSetting('freee_username_encrypted', encrypt('database-user'));
    setSetting('freee_password_encrypted', encrypt('database-password'));
    process.env.LOGIN_USERNAME = 'environment-user';
    process.env.LOGIN_PASSWORD = 'synthetic-environment-password';

    expect(getCredentials()).toEqual({ username: 'database-user', password: 'database-password' });
  });

  it('uses complete environment credentials when no database account is selected and ignores stored plaintext', () => {
    setSetting('freee_username', 'stale-plaintext-user');
    expect(getCredentials()).toEqual({ username: '', password: '' });
    process.env.LOGIN_USERNAME = 'environment-user';
    process.env.LOGIN_PASSWORD = 'synthetic-environment-password';

    expect(getCredentials()).toEqual({ username: 'environment-user', password: 'synthetic-environment-password' });
  });

  it('allows Web mode with Web credentials even when OAuth is unavailable', () => {
    setSetting('connection_mode', 'browser');
    setSetting('oauth_configured', '0');
    process.env.LOGIN_USERNAME = 'synthetic-web-user';
    process.env.LOGIN_PASSWORD = 'synthetic-web-password';

    expect(hasWebCredentials()).toBe(true);
    expect(hasApiCredentials()).toBe(false);
    expect(hasCredentials()).toBe(true);
  });

  it('requires OAuth readiness when API mode is selected', () => {
    setSetting('connection_mode', 'api');
    setSetting('oauth_configured', '0');
    process.env.LOGIN_USERNAME = 'synthetic-web-user';
    process.env.LOGIN_PASSWORD = 'synthetic-web-password';

    expect(hasCredentials()).toBe(false);
    setSetting('oauth_configured', '1');
    expect(hasCredentials()).toBe(true);
  });

  it('keeps Web company identity separate from OAuth and prefers explicit Web config', () => {
    setSetting('oauth_company_name', 'OAuth Example Company');
    process.env.FREEE_COMPANY_NAME = 'Environment Example Company';
    expect(getWebCompanyName()).toBe('Environment Example Company');

    setSetting('web_company_name', 'Configured Example Company');
    expect(getWebCompanyName()).toBe('Configured Example Company');
  });
});
