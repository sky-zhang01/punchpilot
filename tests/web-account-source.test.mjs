import { describe, expect, it } from 'vitest';
import { resolveWebAccount } from '../server/web-account.js';

const env = { LOGIN_USERNAME: 'env-user', LOGIN_PASSWORD: 'env-secret', FREEE_COMPANY_NAME: 'Example' };
const decrypt = value => value.startsWith('cipher:') ? value.slice(7) : '';
function read(settings, environment = env) { return resolveWebAccount(key => settings[key] || '', decrypt, environment); }

describe('one Web account source', () => {
  it('refuses residual ciphertext and does not mix environment credentials', () => {
    expect(read({ freee_username_encrypted: 'cipher:db-user' })).toMatchObject({ valid: false, username: '', code: 'WEB_CREDENTIAL_STATE_INVALID', employeeId: '' });
  });
  it('refuses incomplete or undecryptable selected database credentials', () => {
    for (const password of ['', 'broken']) expect(read({ freee_configured: '1', freee_username_encrypted: 'cipher:db-user', freee_password_encrypted: password })).toMatchObject({ source: 'database', valid: false, username: '', employeeId: '' });
  });
  it('binds environment verification to credentials and company', () => {
    const initial = read({});
    const settings = { web_employee_id_encrypted: 'cipher:17', web_verified_credential_digest: initial.verificationDigest };
    expect(read(settings)).toMatchObject({ valid: true, source: 'environment', employeeId: '17' });
    expect(read(settings, { ...env, LOGIN_USERNAME: 'someone-else' }).employeeId).toBe('');
    expect(read(settings, { ...env, LOGIN_PASSWORD: 'changed' }).employeeId).toBe('');
    expect(read(settings, { ...env, FREEE_COMPANY_NAME: 'Other' }).employeeId).toBe('');
    expect(read(settings, { ...env, FREEE_EMPLOYEE_ID: 'bad' }).employeeId).toBe('');
    expect(read(settings, { ...env, FREEE_EMPLOYEE_ID: '29' }).employeeId).toBe('29');
  });
  it('does not reuse stored employee identity without a matching verification', () => {
    expect(read({ web_employee_id_encrypted: 'cipher:17' })).toMatchObject({ valid: true, employeeId: '' });
  });
});
