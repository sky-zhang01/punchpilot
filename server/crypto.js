import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Key stored in /app/keystore/ (Docker named volume, NOT in the bind-mounted data/ directory).
// Stealing the data/ directory alone cannot decrypt anything — the key is isolated.
const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore');
const SECRET_FILE = path.join(KEYSTORE_DIR, '.app-secret');

// Legacy location (data/ directory) — used only for one-time migration
const OLD_SECRET_FILE = path.resolve(__dirname, '..', 'data', '.app-secret');

/**
 * Migrate .app-secret from data/ (bind mount, exposed to host) to keystore/ (named volume, isolated).
 * Called once at startup. After migration, the old file is securely overwritten then deleted.
 */
function migrateSecretLocation() {
  if (!fs.existsSync(OLD_SECRET_FILE)) return;
  if (fs.existsSync(SECRET_FILE)) {
    // New location already has a key — just securely delete the old one
    try {
      fs.writeFileSync(OLD_SECRET_FILE, crypto.randomBytes(64).toString('hex'));
      fs.rmSync(OLD_SECRET_FILE);
      console.log('[Crypto] Removed leftover .app-secret from data/ (already in keystore/)');
    } catch {}
    return;
  }

  // Move key: read from old, write to new, securely delete old
  try {
    const secret = fs.readFileSync(OLD_SECRET_FILE, 'utf8').trim();
    if (secret.length >= 32) {
      if (!fs.existsSync(KEYSTORE_DIR)) fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
      fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
      // Securely delete: overwrite with random data before removing
      fs.writeFileSync(OLD_SECRET_FILE, crypto.randomBytes(64).toString('hex'));
      fs.rmSync(OLD_SECRET_FILE);
      console.log('[Crypto] Migrated .app-secret from data/ to keystore/ (secure)');
    }
  } catch (e) {
    console.error('[Crypto] Secret migration failed:', e.message);
  }
}

/**
 * Get or generate the application encryption key.
 * Priority: APP_SECRET env > keystore/.app-secret > auto-generate
 */
function getAppSecret() {
  // 1. Check environment variable
  if (process.env.APP_SECRET) {
    return process.env.APP_SECRET;
  }

  // 2. Check keystore file
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (secret.length >= 32) return secret;
    }
  } catch {}

  // 3. Auto-generate and persist to keystore
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(KEYSTORE_DIR)) fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    console.log('[Crypto] Generated new app secret in keystore/');
  } catch (e) {
    console.error('[Crypto] Warning: could not persist app secret:', e.message);
  }
  return secret;
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


/**
 * Encrypt a string using AES-256-GCM
 */
export function encrypt(text) {
  if (!text) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
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
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
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
export function migrateEncryptionIfNeeded(getSetting, setSetting) {
  // Step 1: Migrate secret file from data/ to keystore/
  migrateSecretLocation();

  // Step 2: Migrate freee_username from plaintext to encrypted
  const plaintextUsername = getSetting('freee_username');
  if (plaintextUsername) {
    const existingEncrypted = getSetting('freee_username_encrypted');
    if (!existingEncrypted) {
      setSetting('freee_username_encrypted', encrypt(plaintextUsername));
      setSetting('freee_username', '');
      console.log('[Crypto] Migrated freee_username to encrypted storage');
    }
  }
}
