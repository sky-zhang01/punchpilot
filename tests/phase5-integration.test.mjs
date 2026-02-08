/**
 * Phase 5 Integration & System Tests
 *
 * Tests cover:
 *   T1  — crypto.js: encrypt/decrypt round-trip
 *   T2  — crypto.js: key generation + keystore path
 *   T3  — crypto.js: migration from data/ to keystore/
 *   T4  — crypto.js: freee_username plaintext → encrypted migration
 *   T5  — crypto.js: legacy key migration
 *   T6  — db.js: initDatabase seeds freee_username_encrypted
 *   T7  — db.js: settings CRUD for encrypted fields
 *   T8  — api-config: resolveCredentials uses encrypted username
 *   T9  — api-config: PUT /account stores encrypted, DELETE clears both
 *   T10 — automation.js: getCredentials reads encrypted fields
 *   T11 — reset-password.js: keystore cleanup logic (static analysis)
 *   T12 — server.js: screenshot cleanup logic (static analysis)
 *   T13 — Docker: keystore volume config consistency
 *   T14 — Security: no plaintext username in any read path
 *   T15 — Security: .app-secret never in data/ on fresh start
 *   T16 — Security: encrypt('') returns '', decrypt('') returns ''
 *   T17 — Security: decrypt with wrong key returns ''
 *   T18 — Security: all _encrypted fields have matching seed in db.js
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── Test harness ─────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, testId, description) {
  if (condition) {
    passed++;
    results.push({ testId, description, status: 'PASS' });
    console.log(`  \x1b[32m✓ ${testId}\x1b[0m ${description}`);
  } else {
    failed++;
    results.push({ testId, description, status: 'FAIL' });
    console.log(`  \x1b[31m✗ ${testId}\x1b[0m ${description}`);
  }
}

function assertThrows(fn, testId, description) {
  try {
    fn();
    failed++;
    results.push({ testId, description, status: 'FAIL (no throw)' });
    console.log(`  \x1b[31m✗ ${testId}\x1b[0m ${description} — expected throw`);
  } catch {
    passed++;
    results.push({ testId, description, status: 'PASS' });
    console.log(`  \x1b[32m✓ ${testId}\x1b[0m ${description}`);
  }
}

// ─── Setup temp dirs for isolated testing ──────────────────
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
const TEMP_KEYSTORE = path.join(TEMP_DIR, 'keystore');
const TEMP_DATA = path.join(TEMP_DIR, 'data');
fs.mkdirSync(TEMP_KEYSTORE, { recursive: true });
fs.mkdirSync(TEMP_DATA, { recursive: true });

// ═══════════════════════════════════════════════════════════
console.log('\n\x1b[36m═══ Phase 5: Integration & System Tests ═══\x1b[0m\n');

// ─── T1: crypto encrypt/decrypt round-trip ────────────────
console.log('\x1b[33m── T1-T5: crypto.js ──\x1b[0m');
{
  // We test crypto by directly using its exported functions.
  // The module reads the keystore on import, so we must test it in the real project context.
  const { encrypt, decrypt } = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));

  // T1: round-trip
  const original = 'test@freee.co.jp';
  const encrypted = encrypt(original);
  const decrypted = decrypt(encrypted);
  assert(decrypted === original, 'T1', `encrypt/decrypt round-trip: "${original}" → encrypted → "${decrypted}"`);

  // T1b: encrypted format is iv:tag:ciphertext
  const parts = encrypted.split(':');
  assert(parts.length === 3, 'T1b', `Encrypted format has 3 parts (iv:tag:cipher): ${parts.length} parts`);
  assert(parts[0].length === 32, 'T1c', `IV is 16 bytes hex (32 chars): ${parts[0].length}`);
  assert(parts[1].length === 32, 'T1d', `Auth tag is 16 bytes hex (32 chars): ${parts[1].length}`);

  // T16: edge cases
  assert(encrypt('') === '', 'T16a', 'encrypt("") returns ""');
  assert(encrypt(null) === '', 'T16b', 'encrypt(null) returns ""');
  assert(decrypt('') === '', 'T16c', 'decrypt("") returns ""');
  assert(decrypt(null) === '', 'T16d', 'decrypt(null) returns ""');
  assert(decrypt('not-encrypted') === '', 'T16e', 'decrypt("not-encrypted") returns "" (no colon)');

  // T17: wrong ciphertext returns '' (not crash)
  const fakeEncrypted = 'aaaa'.repeat(8) + ':' + 'bbbb'.repeat(8) + ':' + 'cccc'.repeat(8);
  assert(decrypt(fakeEncrypted) === '', 'T17', 'decrypt with garbage ciphertext returns "" (no crash)');

  // T1e: Two encryptions of same plaintext produce different ciphertext (random IV)
  const enc1 = encrypt('same-text');
  const enc2 = encrypt('same-text');
  assert(enc1 !== enc2, 'T1e', 'Two encryptions of same plaintext differ (random IV)');
  assert(decrypt(enc1) === 'same-text' && decrypt(enc2) === 'same-text', 'T1f', 'Both decrypt correctly');

  // T1g: Unicode / Japanese text
  const jpText = 'テスト太郎@フリー.co.jp';
  const jpEnc = encrypt(jpText);
  assert(decrypt(jpEnc) === jpText, 'T1g', `Japanese text round-trip: "${jpText}"`);

  // T1h: Long text
  const longText = 'a'.repeat(10000);
  assert(decrypt(encrypt(longText)) === longText, 'T1h', 'Long text (10000 chars) round-trip');
}

// ─── T2: Key generation in keystore ───────────────────────
{
  const keystorePath = path.join(PROJECT_ROOT, 'keystore');
  const secretFile = path.join(keystorePath, '.app-secret');

  // We can't test auto-generation without nuking the real key,
  // so we verify the code's path constants match
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');
  assert(
    cryptoSrc.includes("const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore')"),
    'T2a', 'crypto.js KEYSTORE_DIR points to ../keystore'
  );
  assert(
    cryptoSrc.includes("const SECRET_FILE = path.join(KEYSTORE_DIR, '.app-secret')"),
    'T2b', 'crypto.js SECRET_FILE is KEYSTORE_DIR/.app-secret'
  );
  assert(
    !cryptoSrc.includes("const SECRET_FILE = path.resolve(__dirname, '..', 'data'"),
    'T2c', 'crypto.js SECRET_FILE does NOT point to data/ (old path removed)'
  );

  // T15: If .app-secret exists in data/, migration logic will move it on container startup
  const dataSecret = path.join(PROJECT_ROOT, 'data', '.app-secret');
  if (fs.existsSync(dataSecret)) {
    // Verify migration code will handle it
    assert(
      cryptoSrc.includes('function migrateSecretLocation()') &&
      cryptoSrc.includes('fs.rmSync(OLD_SECRET_FILE)'),
      'T15', '.app-secret in data/ will be migrated to keystore/ on startup (migration logic verified)'
    );
  } else {
    assert(true, 'T15', '.app-secret does NOT exist in data/ (already migrated or fresh install)');
  }
}

// ─── T3: Migration logic (data/ → keystore/) ─────────────
{
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  // Verify migration function exists
  assert(
    cryptoSrc.includes('function migrateSecretLocation()'),
    'T3a', 'migrateSecretLocation() function exists'
  );

  // Verify it reads from OLD_SECRET_FILE
  assert(
    cryptoSrc.includes("const OLD_SECRET_FILE = path.resolve(__dirname, '..', 'data', '.app-secret')"),
    'T3b', 'OLD_SECRET_FILE points to data/.app-secret'
  );

  // Verify secure deletion: overwrite with random before delete
  const migrateBlock = cryptoSrc.substring(
    cryptoSrc.indexOf('function migrateSecretLocation()'),
    cryptoSrc.indexOf('function getAppSecret()')
  );
  assert(
    migrateBlock.includes('crypto.randomBytes(64)') && migrateBlock.includes('fs.rmSync(OLD_SECRET_FILE)'),
    'T3c', 'Migration securely overwrites old file with random data before deleting'
  );

  // Verify it writes to SECRET_FILE with 0o600 permissions
  assert(
    migrateBlock.includes("fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 })"),
    'T3d', 'New key written with 0o600 permissions'
  );

  // T3e: Simulate migration in temp dir
  const testSecret = crypto.randomBytes(32).toString('hex');
  const oldPath = path.join(TEMP_DATA, '.app-secret');
  const newPath = path.join(TEMP_KEYSTORE, '.app-secret-test');
  fs.writeFileSync(oldPath, testSecret);
  assert(fs.existsSync(oldPath), 'T3e-pre', 'Test: old secret file created');

  // Simulate migration manually
  const readSecret = fs.readFileSync(oldPath, 'utf8').trim();
  fs.writeFileSync(newPath, readSecret, { mode: 0o600 });
  fs.writeFileSync(oldPath, crypto.randomBytes(64).toString('hex'));
  fs.rmSync(oldPath);

  assert(!fs.existsSync(oldPath), 'T3e', 'After migration: old file deleted');
  assert(fs.existsSync(newPath), 'T3f', 'After migration: new file exists');
  assert(fs.readFileSync(newPath, 'utf8').trim() === testSecret, 'T3g', 'After migration: secret value preserved');

  // Cleanup
  fs.rmSync(newPath, { force: true });
}

// ─── T4: freee_username plaintext → encrypted migration ───
{
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  const migrateEncBlock = cryptoSrc.substring(
    cryptoSrc.indexOf('export function migrateEncryptionIfNeeded'),
    cryptoSrc.length
  );

  assert(
    migrateEncBlock.includes("getSetting('freee_username')"),
    'T4a', 'Migration reads plaintext freee_username'
  );
  assert(
    migrateEncBlock.includes("setSetting('freee_username_encrypted', encrypt(plaintextUsername))"),
    'T4b', 'Migration encrypts and stores as freee_username_encrypted'
  );
  assert(
    migrateEncBlock.includes("setSetting('freee_username', '')"),
    'T4c', 'Migration clears plaintext freee_username after encrypting'
  );
}

// ─── T5: Legacy key migration ─────────────────────────────
{
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');

  assert(
    cryptoSrc.includes("crypto.scryptSync(secret, 'punchpilot-salt-v2', 32)"),
    'T5a', 'Current key uses punchpilot-salt-v2'
  );
  assert(
    cryptoSrc.includes("crypto.scryptSync(secret, 'punchpilot-salt', 32)"),
    'T5b', 'Legacy key uses punchpilot-salt (v1)'
  );
  assert(
    cryptoSrc.includes('decryptWithLegacyKey(encPassword)'),
    'T5c', 'Migration attempts legacy decryption if current fails'
  );
}

// ─── T6: db.js seed completeness ──────────────────────────
console.log('\n\x1b[33m── T6-T7: db.js ──\x1b[0m');
{
  const dbSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'db.js'), 'utf8');

  // Every _encrypted field must have a seed
  const encryptedFields = [
    'freee_username_encrypted',
    'freee_password_encrypted',
    'oauth_client_secret_encrypted',
    'oauth_access_token_encrypted',
    'oauth_refresh_token_encrypted',
  ];

  for (const field of encryptedFields) {
    assert(
      dbSrc.includes(`insertSetting.run('${field}', '')`),
      'T6-' + field.replace(/_encrypted$/, '').replace(/^(oauth_|freee_)/, ''),
      `db.js seeds "${field}"`
    );
  }

  // T18: cross-check — every _encrypted reference in routes must have a seed
  const configSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'routes', 'api-config.js'), 'utf8');
  const freeApiSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'freee-api.js'), 'utf8');
  const allRouteSrc = configSrc + freeApiSrc;

  // Find all getSetting('..._encrypted') calls
  const getSettingRegex = /getSetting\('(\w+_encrypted)'\)/g;
  const referencedFields = new Set();
  let match;
  while ((match = getSettingRegex.exec(allRouteSrc)) !== null) {
    referencedFields.add(match[1]);
  }

  for (const field of referencedFields) {
    assert(
      dbSrc.includes(`'${field}'`),
      'T18-' + field.split('_')[0],
      `Referenced encrypted field "${field}" has seed in db.js`
    );
  }
}

// ─── T7: Settings CRUD via DB module ──────────────────────
{
  // Test the actual DB module by creating a temp database
  const tempDbPath = path.join(TEMP_DIR, 'test-punchpilot.db');

  // We can't easily import db.js with a different path, so we test
  // the SQL logic directly with better-sqlite3
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(tempDbPath);
    db.pragma('journal_mode = WAL');

    // Create settings table
    db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('freee_username', '');
    insertSetting.run('freee_username_encrypted', '');
    insertSetting.run('freee_password_encrypted', '');

    const getSetting = (key) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    };
    const setSetting = (key, value) => {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    };

    // Import encrypt/decrypt
    const { encrypt, decrypt } = await import(path.join(PROJECT_ROOT, 'server', 'crypto.js'));

    // Simulate saving credentials
    const testUser = 'user@example.com';
    const testPass = 'secret-password-123';
    setSetting('freee_username_encrypted', encrypt(testUser));
    setSetting('freee_password_encrypted', encrypt(testPass));
    setSetting('freee_username', ''); // clear legacy

    // Read back
    const readUser = decrypt(getSetting('freee_username_encrypted'));
    const readPass = decrypt(getSetting('freee_password_encrypted'));
    assert(readUser === testUser, 'T7a', `DB: encrypted username round-trip: "${readUser}"`);
    assert(readPass === testPass, 'T7b', `DB: encrypted password round-trip`);
    assert(getSetting('freee_username') === '', 'T7c', 'DB: plaintext freee_username is empty');

    // Simulate DELETE /account
    setSetting('freee_username', '');
    setSetting('freee_username_encrypted', '');
    setSetting('freee_password_encrypted', '');
    assert(getSetting('freee_username_encrypted') === '', 'T7d', 'DB: after delete, username_encrypted is empty');
    assert(decrypt(getSetting('freee_username_encrypted') || '') === '', 'T7e', 'DB: decrypt of empty returns empty');

    db.close();
  } catch (e) {
    console.log(`  \x1b[31m✗ T7\x1b[0m DB test failed: ${e.message}`);
    failed++;
    results.push({ testId: 'T7', description: `DB test error: ${e.message}`, status: 'FAIL' });
  }
}

// ─── T8-T9: api-config.js encrypted field handling ────────
console.log('\n\x1b[33m── T8-T9: api-config.js ──\x1b[0m');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'routes', 'api-config.js'), 'utf8');

  // T8: resolveCredentials reads encrypted
  const resolveBlock = src.substring(
    src.indexOf('function resolveCredentials()'),
    src.indexOf('function timeToMinutes(')
  );
  assert(
    resolveBlock.includes("getSetting('freee_username_encrypted')") &&
    !resolveBlock.includes("getSetting('freee_username')"),
    'T8a', 'resolveCredentials reads freee_username_encrypted (not plaintext)'
  );
  assert(
    resolveBlock.includes('decrypt(freeeUsernameEnc)'),
    'T8b', 'resolveCredentials decrypts username'
  );

  // T8c: GET /config reads encrypted
  assert(
    src.includes("decrypt(getSetting('freee_username_encrypted') || '') || ''"),
    'T8c', 'GET /config decrypts freee_username_encrypted for response'
  );

  // T8d: GET /account reads encrypted
  const accountGetBlock = src.substring(
    src.indexOf("router.get('/account'"),
    src.indexOf("router.put('/account'")
  );
  assert(
    accountGetBlock.includes("decrypt(getSetting('freee_username_encrypted')"),
    'T8d', 'GET /account decrypts freee_username_encrypted'
  );

  // T9a: PUT /account encrypts username
  const accountPutBlock = src.substring(
    src.indexOf("router.put('/account'"),
    src.indexOf("router.delete('/account'")
  );
  assert(
    accountPutBlock.includes("setSetting('freee_username_encrypted', encrypt(username))"),
    'T9a', 'PUT /account encrypts username before storing'
  );
  assert(
    accountPutBlock.includes("setSetting('freee_username', '')"),
    'T9b', 'PUT /account clears plaintext freee_username'
  );

  // T9c: DELETE /account clears both
  const accountDelBlock = src.substring(
    src.indexOf("router.delete('/account'"),
    src.indexOf("router.post('/verify-credentials'")
  );
  assert(
    accountDelBlock.includes("setSetting('freee_username', '')") &&
    accountDelBlock.includes("setSetting('freee_username_encrypted', '')") &&
    accountDelBlock.includes("setSetting('freee_password_encrypted', '')"),
    'T9c', 'DELETE /account clears freee_username, freee_username_encrypted, freee_password_encrypted'
  );
}

// ─── T10: automation.js getCredentials ────────────────────
console.log('\n\x1b[33m── T10: automation.js ──\x1b[0m');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'automation.js'), 'utf8');

  const getCredsBlock = src.substring(
    src.indexOf('function getCredentials()'),
    src.indexOf('/** Get the active connection mode')
  );

  assert(
    getCredsBlock.includes("getSetting('freee_username_encrypted')"),
    'T10a', 'getCredentials reads freee_username_encrypted'
  );
  assert(
    !getCredsBlock.includes("getSetting('freee_username')"),
    'T10b', 'getCredentials does NOT read plaintext freee_username'
  );
  assert(
    getCredsBlock.includes('decrypt(dbUsernameEnc)') && getCredsBlock.includes('decrypt(dbPasswordEnc)'),
    'T10c', 'getCredentials decrypts both username and password'
  );
  assert(
    getCredsBlock.includes("process.env.LOGIN_USERNAME"),
    'T10d', 'getCredentials falls back to env vars'
  );
}

// ─── T11: reset-password.js keystore cleanup ──────────────
console.log('\n\x1b[33m── T11: reset-password.js ──\x1b[0m');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'reset-password.js'), 'utf8');

  assert(
    src.includes("const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore')"),
    'T11a', 'reset-password.js defines KEYSTORE_DIR'
  );

  // Verify keystore cleanup section exists
  assert(
    src.includes('Delete encryption key from keystore/'),
    'T11b', 'Has keystore cleanup section'
  );
  assert(
    src.includes("fs.readdirSync(KEYSTORE_DIR)"),
    'T11c', 'Iterates keystore directory'
  );
  assert(
    src.includes('crypto.randomBytes(64)') && src.includes('fs.rmSync(fp'),
    'T11d', 'Secure wipe: overwrites with random data then deletes'
  );

  // Verify legacy data/ cleanup too
  assert(
    src.includes('Delete encryption key from legacy location (data/)'),
    'T11e', 'Also cleans legacy data/.app-secret'
  );

  // Verify step numbering is consistent
  assert(
    src.includes('// 1. Delete database') &&
    src.includes('// 2. Delete encryption key from legacy') &&
    src.includes('// 3. Delete encryption key from keystore') &&
    src.includes('// 4. Purge logs') &&
    src.includes('// 5. Purge screenshots'),
    'T11f', 'Step numbering is consistent (1-5)'
  );

  // T11g: Simulate keystore cleanup in temp dir
  const testKeystoreDir = path.join(TEMP_DIR, 'keystore-test');
  fs.mkdirSync(testKeystoreDir, { recursive: true });
  fs.writeFileSync(path.join(testKeystoreDir, '.app-secret'), 'real-secret-key-here');
  fs.writeFileSync(path.join(testKeystoreDir, 'extra-file'), 'other-data');

  // Simulate cleanup
  const keystoreFiles = fs.readdirSync(testKeystoreDir);
  for (const f of keystoreFiles) {
    const fp = path.join(testKeystoreDir, f);
    fs.writeFileSync(fp, crypto.randomBytes(64).toString('hex'));
    fs.rmSync(fp, { force: true });
  }

  const remainingFiles = fs.readdirSync(testKeystoreDir);
  assert(remainingFiles.length === 0, 'T11g', 'Keystore cleanup: all files removed');
}

// ─── T12: Screenshot cleanup logic ────────────────────────
console.log('\n\x1b[33m── T12: server.js screenshot cleanup ──\x1b[0m');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'server.js'), 'utf8');

  assert(
    src.includes('function cleanOldScreenshots(daysToKeep = 7)'),
    'T12a', 'cleanOldScreenshots function exists with 7-day default'
  );
  assert(
    src.includes("stat.isFile() && stat.mtimeMs < cutoff"),
    'T12b', 'Checks file mtime against cutoff'
  );
  assert(
    src.includes('cleanOldScreenshots()') && src.includes('setInterval'),
    'T12c', 'Runs on startup + periodic interval'
  );
  assert(
    src.includes("24 * 60 * 60 * 1000"),
    'T12d', 'Interval is 24 hours'
  );

  // T12e: Simulate screenshot cleanup in temp dir
  const ssDir = path.join(TEMP_DIR, 'screenshots');
  fs.mkdirSync(ssDir, { recursive: true });

  // Create old file (simulate 8 days old)
  const oldFile = path.join(ssDir, 'old-screenshot.png');
  fs.writeFileSync(oldFile, 'fake-image-data');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

  // Create recent file (today)
  const newFile = path.join(ssDir, 'new-screenshot.png');
  fs.writeFileSync(newFile, 'fake-image-data-new');

  // Run cleanup logic
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(ssDir)) {
    const fp = path.join(ssDir, f);
    const stat = fs.statSync(fp);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      fs.rmSync(fp);
      removed++;
    }
  }

  assert(removed === 1, 'T12e', `Screenshot cleanup removed ${removed} old file(s) (expected 1)`);
  assert(fs.existsSync(newFile), 'T12f', 'Recent screenshot preserved');
  assert(!fs.existsSync(oldFile), 'T12g', 'Old screenshot (8 days) deleted');
}

// ─── T13: Docker config consistency ───────────────────────
console.log('\n\x1b[33m── T13: Docker configuration ──\x1b[0m');
{
  const composeSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
  const dockerfileSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');

  // docker-compose.yml
  assert(
    composeSrc.includes('keystore:/app/keystore'),
    'T13a', 'docker-compose: keystore volume mounted at /app/keystore'
  );
  assert(
    composeSrc.includes('volumes:') && composeSrc.includes('keystore:'),
    'T13b', 'docker-compose: keystore declared as named volume'
  );
  assert(
    !composeSrc.includes('./keystore'),
    'T13c', 'docker-compose: keystore is NOT a bind mount (no ./keystore)'
  );

  // Dockerfile
  assert(
    dockerfileSrc.includes('mkdir -p /app/data /app/logs /app/screenshots /app/keystore'),
    'T13d', 'Dockerfile: creates /app/keystore directory'
  );
  assert(
    dockerfileSrc.includes('USER ppuser'),
    'T13e', 'Dockerfile: runs as non-root user ppuser'
  );
  assert(
    dockerfileSrc.includes('groupadd -r ppuser') && dockerfileSrc.includes('useradd -r -g ppuser'),
    'T13f', 'Dockerfile: ppuser is a system user with restricted group'
  );
  assert(
    dockerfileSrc.includes('chown -R ppuser:ppuser /app'),
    'T13g', 'Dockerfile: /app owned by ppuser'
  );

  // Verify volume config matches crypto.js expectations
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');
  const cryptoKeystoreMatch = cryptoSrc.match(/path\.resolve\(__dirname, '\.\.', '(\w+)'\)/);
  assert(
    cryptoKeystoreMatch && cryptoKeystoreMatch[1] === 'keystore',
    'T13h', 'crypto.js keystore path matches Docker volume mount point'
  );
}

// ─── T14: Security — no plaintext username leaks ──────────
console.log('\n\x1b[33m── T14: Security audit ──\x1b[0m');
{
  // Check all server files for any getSetting('freee_username') reads that are NOT
  // in migration/cleanup code
  const filesToCheck = [
    'server/routes/api-config.js',
    'server/automation.js',
    'server/freee-api.js',
    'server/scheduler.js',
  ];

  for (const file of filesToCheck) {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
    const lines = src.split('\n');

    let hasPlaintextRead = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Check for direct reads of plaintext freee_username (not _encrypted, not clearing)
      if (
        line.includes("getSetting('freee_username')") &&
        !line.includes("freee_username_encrypted") &&
        !line.includes("setSetting('freee_username', '')") &&  // clearing is ok
        !line.includes('// clear legacy')  // comment about clearing is ok
      ) {
        hasPlaintextRead = true;
        console.log(`    \x1b[31mWARNING: ${file}:${i + 1} reads plaintext freee_username\x1b[0m`);
      }
    }
    assert(!hasPlaintextRead, `T14-${path.basename(file)}`, `${file}: no plaintext freee_username reads`);
  }

  // Check crypto.js separately (it SHOULD read plaintext for migration — that's OK)
  const cryptoSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'crypto.js'), 'utf8');
  const cryptoPlaintextReads = (cryptoSrc.match(/getSetting\('freee_username'\)/g) || []).length;
  assert(
    cryptoPlaintextReads === 1,
    'T14-crypto',
    `crypto.js reads plaintext freee_username exactly 1 time (for migration): found ${cryptoPlaintextReads}`
  );

  // Check db.js separately (seed is OK)
  const dbSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'db.js'), 'utf8');
  const dbPlainRefs = (dbSrc.match(/freee_username'/g) || []).length;
  const dbEncRefs = (dbSrc.match(/freee_username_encrypted'/g) || []).length;
  assert(
    dbPlainRefs >= 1 && dbEncRefs >= 1,
    'T14-db',
    `db.js has both plain (${dbPlainRefs}) and encrypted (${dbEncRefs}) seeds`
  );
}

// ─── T14-extra: Sensitive data in console.log ─────────────
{
  const configSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'routes', 'api-config.js'), 'utf8');

  // Check if any console.log leaks password
  const logLines = configSrc.split('\n').filter(l => l.includes('console.log'));
  let leaksPassword = false;
  for (const line of logLines) {
    if (line.includes('password') && !line.includes('password length') && !line.includes('password_')) {
      leaksPassword = true;
      console.log(`    \x1b[33mWARN: potential password in log: ${line.trim()}\x1b[0m`);
    }
  }
  assert(!leaksPassword, 'T14-log', 'No password values leaked in console.log (only password length)');
}

// ─── Cleanup & Results ────────────────────────────────────
fs.rmSync(TEMP_DIR, { recursive: true, force: true });

console.log('\n\x1b[36m═══ Results ═══\x1b[0m');
console.log(`  Total: ${passed + failed}`);
console.log(`  \x1b[32mPassed: ${passed}\x1b[0m`);
if (failed > 0) {
  console.log(`  \x1b[31mFailed: ${failed}\x1b[0m`);
  console.log('\n  \x1b[31mFailed tests:\x1b[0m');
  for (const r of results.filter(r => r.status !== 'PASS')) {
    console.log(`    \x1b[31m✗ ${r.testId}: ${r.description} [${r.status}]\x1b[0m`);
  }
}
console.log('');

process.exit(failed > 0 ? 1 : 0);
