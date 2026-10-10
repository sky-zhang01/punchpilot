import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  initDatabase,
  setSettingsAtomically,
} from '../server/db.js';
import { encrypt } from '../server/crypto.js';
import {
  assertWebAccountBinding,
  captureWebAccountBinding,
  currentAutomationIdentityKey,
  isWebAccountVerified,
} from '../server/automation/identity.js';

function seedWebIdentity({
  generation = '1',
  companyName = 'Synthetic Web Company',
  employeeId = '1001',
} = {}) {
  setSettingsAtomically([
    ['connection_mode', 'browser'],
    ['debug_mode', '0'],
    ['freee_configured', '1'],
    ['freee_username_encrypted', encrypt('synthetic-web-user')],
    ['freee_password_encrypted', encrypt('synthetic-web-password')],
    ['web_company_name', companyName],
    ['web_employee_id_encrypted', encrypt(employeeId)],
    ['web_identity_generation', generation],
  ]);
}

beforeAll(() => {
  initDatabase();
});

beforeEach(() => {
  seedWebIdentity();
});

describe('automation identity scope', () => {
  it('requires credentials, company, and employee binding before reporting verified', () => {
    expect(isWebAccountVerified()).toBe(true);

    seedWebIdentity({ employeeId: '' });

    expect(isWebAccountVerified()).toBe(false);
  });

  it('uses an opaque stable digest without account or company plaintext', () => {
    const first = currentAutomationIdentityKey();
    const second = currentAutomationIdentityKey();

    expect(first).toBe(second);
    expect(first).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(first).not.toContain('synthetic-web-user');
    expect(first).not.toContain('Synthetic Web Company');
  });

  it('invalidates a captured Web binding when its generation changes', () => {
    const binding = captureWebAccountBinding();
    const firstKey = currentAutomationIdentityKey();

    seedWebIdentity({ generation: '2' });

    expect(() => assertWebAccountBinding(binding)).toThrowError(
      expect.objectContaining({ code: 'WEB_ACCOUNT_IDENTITY_CHANGED' }),
    );
    expect(currentAutomationIdentityKey()).not.toBe(firstKey);
  });

  it('separates Web company and debug-mode schedules', () => {
    const liveKey = currentAutomationIdentityKey();
    seedWebIdentity({ companyName: 'Synthetic Other Company' });
    const otherCompanyKey = currentAutomationIdentityKey();
    setSettingsAtomically([['debug_mode', '1']]);
    const debugKey = currentAutomationIdentityKey();

    expect(otherCompanyKey).not.toBe(liveKey);
    expect(debugKey).not.toBe(otherCompanyKey);
  });

  it('invalidates a Web binding when the verified employee changes', () => {
    const binding = captureWebAccountBinding();
    const firstKey = currentAutomationIdentityKey();

    seedWebIdentity({ employeeId: '2002' });

    expect(() => assertWebAccountBinding(binding)).toThrowError(
      expect.objectContaining({ code: 'WEB_ACCOUNT_IDENTITY_CHANGED' }),
    );
    expect(currentAutomationIdentityKey()).not.toBe(firstKey);
  });

  it('separates OAuth and Web schedule scopes', () => {
    const webKey = currentAutomationIdentityKey();
    setSettingsAtomically([
      ['connection_mode', 'api'],
      ['oauth_identity_generation', '3'],
      ['oauth_company_id', '101'],
      ['oauth_employee_id', '1001'],
    ]);

    expect(currentAutomationIdentityKey()).not.toBe(webKey);
  });
});
