import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { KEYSTORE_DIR, LEGACY_SECRET_FILE } from './paths.js';

// Key stored in /app/keystore/ (Docker named volume, NOT in the bind-mounted data/ directory).
// Stealing the data/ directory alone cannot decrypt anything — the key is isolated.
const SECRET_FILE = path.join(KEYSTORE_DIR, '.app-secret');

// Legacy location (data/ directory) — used only for one-time migration
const OLD_SECRET_FILE = LEGACY_SECRET_FILE;
const SECRET_MIN_BYTES = 32;

function appSecretFileError(message, code = 'APP_SECRET_FILE_UNSAFE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathExistsNoFollow(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function ownerIsAllowed(metadata) {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return currentUid === null || metadata.uid === 0 || metadata.uid === currentUid;
}

function ensurePrivateKeystore() {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(KEYSTORE_DIR);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownerIsAllowed(metadata)) {
    throw appSecretFileError('Application keystore must be a private directory.');
  }
  fs.chmodSync(KEYSTORE_DIR, 0o700);
}

function validateSecret(secret, source) {
  if (Buffer.byteLength(secret, 'utf8') < SECRET_MIN_BYTES) {
    throw new Error(`${source} must be at least ${SECRET_MIN_BYTES} bytes`);
  }
  return secret;
}

function readSecretFile(file, source) {
  let descriptor;
  try {
    const pathMetadata = fs.lstatSync(file);
    if (pathMetadata.isSymbolicLink()) throw appSecretFileError('Application secret file must be a private regular file.');

    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || !ownerIsAllowed(metadata)) {
      throw appSecretFileError('Application secret file must be a private regular file.');
    }
    if (metadata.mode & 0o077) fs.fchmodSync(descriptor, 0o600);
    return validateSecret(fs.readFileSync(descriptor, 'utf8').trim(), source);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'APP_SECRET_FILE_UNSAFE') throw error;
    throw appSecretFileError('Application secret file must be a private regular file.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeSecretFileExclusive(file, secret) {
  fs.writeFileSync(file, secret, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function secretsMatch(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Migrate .app-secret from data/ (bind mount, exposed to host) to keystore/ (named volume, isolated).
 * Conflicting or unsafe key files stop startup without deleting either source.
 */
function migrateSecretLocation() {
  if (!pathExistsNoFollow(OLD_SECRET_FILE)) return;

  const legacySecret = readSecretFile(OLD_SECRET_FILE, 'legacy keystore secret');
  ensurePrivateKeystore();

  if (pathExistsNoFollow(SECRET_FILE)) {
    const currentSecret = readSecretFile(SECRET_FILE, 'keystore secret');
    if (!secretsMatch(legacySecret, currentSecret)) {
      throw appSecretFileError(
        'Legacy and current application secrets conflict; refusing automatic migration.',
        'APP_SECRET_FILE_CONFLICT',
      );
    }
  } else {
    try {
      writeSecretFileExclusive(SECRET_FILE, legacySecret);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const currentSecret = readSecretFile(SECRET_FILE, 'keystore secret');
      if (!secretsMatch(legacySecret, currentSecret)) {
        throw appSecretFileError(
          'Legacy and current application secrets conflict; refusing automatic migration.',
          'APP_SECRET_FILE_CONFLICT',
        );
      }
    }
  }

  fs.rmSync(OLD_SECRET_FILE);
  console.log('[Crypto] Migrated legacy app secret into the keystore');
}

/**
 * Get or generate the application encryption key.
 * APP_SECRET and keystore/.app-secret are two representations of one key.
 * When both exist they must match; a configured secret is persisted so later
 * removal of the environment variable cannot silently rotate encrypted data.
 */
function getAppSecret() {
  if (process.env.APP_SECRET) {
    const configuredSecret = validateSecret(process.env.APP_SECRET, 'APP_SECRET');
    ensurePrivateKeystore();
    if (pathExistsNoFollow(SECRET_FILE)) {
      const storedSecret = readSecretFile(SECRET_FILE, 'keystore secret');
      if (!secretsMatch(configuredSecret, storedSecret)) {
        throw appSecretFileError(
          'APP_SECRET conflicts with the existing keystore secret; refusing to replace encrypted data.',
          'APP_SECRET_FILE_CONFLICT',
        );
      }
    } else {
      try {
        writeSecretFileExclusive(SECRET_FILE, configuredSecret);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const storedSecret = readSecretFile(SECRET_FILE, 'keystore secret');
        if (!secretsMatch(configuredSecret, storedSecret)) {
          throw appSecretFileError(
            'APP_SECRET conflicts with the existing keystore secret; refusing to replace encrypted data.',
            'APP_SECRET_FILE_CONFLICT',
          );
        }
      }
    }
    return configuredSecret;
  }

  ensurePrivateKeystore();
  if (pathExistsNoFollow(SECRET_FILE)) {
    return readSecretFile(SECRET_FILE, 'keystore secret');
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    writeSecretFileExclusive(SECRET_FILE, secret);
    console.log('[Crypto] Generated new app secret in keystore/');
    return secret;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readSecretFile(SECRET_FILE, 'keystore secret');
  }
}

let _cachedKey = null;

function getEncryptionKey() {
  if (!_cachedKey) {
    const secret = getAppSecret();
    // Static salt is acceptable: the secret is already 256-bit random per-installation.
    // Explicit scrypt params: N=16384, r=8, p=1 (OWASP recommended minimum).
    _cachedKey = crypto.scryptSync(secret, 'punchpilot-salt', 32, { N: 16384, r: 8, p: 1 });
  }
  return _cachedKey;
}

export function deriveKeyedDigest(namespace, parts) {
  if (
    typeof namespace !== 'string' ||
    !namespace ||
    !Array.isArray(parts)
  ) {
    throw new TypeError('A digest namespace and value list are required');
  }
  return crypto
    .createHmac('sha256', getEncryptionKey())
    .update(namespace)
    .update('\u0000')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex');
}


/**
 * Encrypt a string using AES-256-GCM
 */
export function encrypt(text) {
  if (!text) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 */
export function decrypt(encryptedText) {
  if (!encryptedText || !encryptedText.includes(':')) return '';
  try {
    const key = getEncryptionKey();
    const parts = encryptedText.split(':');
    if (parts.length !== 3) return '';
    const [ivHex, tagHex, encrypted] = parts;
    if (
      !/^[a-f0-9]{32}$/i.test(ivHex) ||
      !/^[a-f0-9]{32}$/i.test(tagHex) ||
      encrypted.length === 0 ||
      encrypted.length % 2 !== 0 ||
      !/^[a-f0-9]+$/i.test(encrypted)
    ) {
      return '';
    }
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}


/**
 * Migrate encrypted data from legacy key to new key.
 * Also migrates .app-secret location from data/ to keystore/.
 * Also migrates plaintext freee_username to encrypted storage.
 * Call this during database initialization.
 */
export function migrateEncryptionIfNeeded(getSetting, setSetting, setSettingsAtomically) {
  // Step 1: Migrate secret file from data/ to keystore/
  migrateSecretLocation();
  // Validate configured and persisted key sources even if no credential needs
  // encryption during this startup.
  getAppSecret();

  // Step 2: Migrate freee_username from plaintext to encrypted
  const plaintextUsername = getSetting('freee_username');
  if (plaintextUsername) {
    const existingEncrypted = getSetting('freee_username_encrypted');
    if (existingEncrypted) {
      const recoveredUsername = decrypt(existingEncrypted);
      if (!recoveredUsername || !secretsMatch(plaintextUsername, recoveredUsername)) {
        const error = new Error(
          'Plaintext and encrypted freee usernames conflict; refusing automatic credential migration.',
        );
        error.code = 'CREDENTIAL_MIGRATION_CONFLICT';
        throw error;
      }
    }

    const updates = [
      ['freee_username_encrypted', existingEncrypted || encrypt(plaintextUsername)],
      ['freee_username', ''],
    ];
    if (setSettingsAtomically) {
      setSettingsAtomically(updates);
    } else {
      for (const [key, value] of updates) setSetting(key, value);
    }
    console.log('[Crypto] Migrated freee_username to encrypted storage');
  }
}
