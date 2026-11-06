import { deriveKeyedDigest } from './crypto.js';
import { parseExternalId } from './freee-values.js';

/** Resolve one credential source for login, verification, employee binding and logs. */
export function resolveWebAccount(readSetting, decryptValue, env = process.env) {
  const database = readSetting('freee_configured') === '1';
  const usernameCipher = readSetting('freee_username_encrypted') || '';
  const passwordCipher = readSetting('freee_password_encrypted') || '';
  const hasEnvironment = Boolean(env.LOGIN_USERNAME || env.LOGIN_PASSWORD);
  const source = database ? 'database' : hasEnvironment ? 'environment' : 'unconfigured';
  const companyName = (readSetting('web_company_name') || env.FREEE_COMPANY_NAME || '').trim();
  let username = database ? decryptValue(usernameCipher) : env.LOGIN_USERNAME || '';
  let password = database ? decryptValue(passwordCipher) : env.LOGIN_PASSWORD || '';
  let code = null;
  if (!database && (usernameCipher || passwordCipher)) code = 'WEB_CREDENTIAL_STATE_INVALID';
  else if (source !== 'unconfigured' && (!username || !password)) code = 'WEB_CREDENTIALS_INVALID';
  const valid = source !== 'unconfigured' && !code && Boolean(username && password);
  if (!valid) { username = ''; password = ''; }
  const verificationDigest = valid ? deriveKeyedDigest('web-account-verification', [source, username, password, companyName]) : '';
  let employeeId = '';
  if (valid) {
    if (database) employeeId = String(parseExternalId(decryptValue(readSetting('web_employee_id_encrypted') || '')) || '');
    else if (env.FREEE_EMPLOYEE_ID) employeeId = String(parseExternalId(env.FREEE_EMPLOYEE_ID) || '');
    else if (verificationDigest === readSetting('web_verified_credential_digest')) {
      employeeId = String(parseExternalId(decryptValue(readSetting('web_employee_id_encrypted') || '')) || '');
    }
  }
  return Object.freeze({ source, valid, code, username, password, companyName, employeeId, verificationDigest,
    credentialIdentity: database ? usernameCipher : username });
}
