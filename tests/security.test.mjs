/**
 * Security Audit Tests
 *
 * Scans all server code for:
 *   - Plaintext freee_username reads outside migration
 *   - Password/secret leaks in console.log
 *   - .app-secret in data/ directory
 *   - Docker config consistency
 *   - reset-password.js keystore cleanup
 *   - Screenshot cleanup logic
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('no plaintext freee_username reads in production code', () => {
  const prodFiles = [
    'server/routes/api-config.js',
    'server/automation.js',
    'server/freee-api.js',
    'server/scheduler.js',
  ];

  for (const file of prodFiles) {
    it(`${file}: no getSetting('freee_username') reads`, () => {
      const src = readSrc(file);
      const lines = src.split('\n');
      const violations = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          line.includes("getSetting('freee_username')") &&
          !line.includes('freee_username_encrypted') &&
          !line.includes("setSetting('freee_username', '')") &&
          !line.includes('// clear legacy')
        ) {
          violations.push(`Line ${i + 1}: ${line.trim()}`);
        }
      }

      expect(violations).toEqual([]);
    });
  }

  it('crypto.js reads plaintext exactly once (for migration)', () => {
    const src = readSrc('server/crypto.js');
    const matches = src.match(/getSetting\('freee_username'\)/g) || [];
    expect(matches).toHaveLength(1);
  });
});

describe('no secrets in console.log', () => {
  const files = [
    'server/routes/api-config.js',
    'server/automation.js',
    'server/server.js',
    'server/scheduler.js',
  ];

  for (const file of files) {
    it(`${file}: no password values in logs`, () => {
      const src = readSrc(file);
      const logLines = src.split('\n').filter(l => l.includes('console.log') || l.includes('log.info') || l.includes('log.error'));
      const leaks = logLines.filter(l =>
        (l.includes('password') || l.includes('secret') || l.includes('token')) &&
        !l.includes('password length') &&
        !l.includes('password_') &&
        !l.includes('_encrypted') &&
        !l.includes('_secret') &&
        !l.includes('_token') &&
        !l.includes('must_change_password') &&
        !l.includes('password_hash')
      );
      expect(leaks).toEqual([]);
    });
  }
});

describe('.app-secret location', () => {
  it('data/.app-secret has migration logic if it exists', () => {
    const dataSecret = path.join(PROJECT_ROOT, 'data', '.app-secret');
    if (fs.existsSync(dataSecret)) {
      const src = readSrc('server/crypto.js');
      expect(src).toContain('function migrateSecretLocation()');
      expect(src).toContain('fs.rmSync(OLD_SECRET_FILE)');
    }
    // If it doesn't exist, test passes automatically
    expect(true).toBe(true);
  });

  it('.gitignore includes data/.app-secret', () => {
    const gitignore = readSrc('.gitignore');
    expect(gitignore).toContain('data/.app-secret');
  });
});

describe('Docker configuration', () => {
  const compose = readSrc('docker-compose.yml');
  const dockerfile = readSrc('Dockerfile');

  it('keystore is a named volume (not bind mount)', () => {
    expect(compose).toContain('keystore:/app/keystore');
    expect(compose).not.toContain('./keystore');
  });

  it('keystore volume is declared', () => {
    expect(compose).toContain('volumes:');
    expect(compose).toContain('keystore:');
  });

  it('Dockerfile creates /app/keystore', () => {
    expect(dockerfile).toContain('/app/keystore');
  });

  it('runs as non-root user (UID 568)', () => {
    expect(dockerfile).toContain('USER 568');
    expect(dockerfile).toContain('groupadd -g 568');
  });

  it('/app is owned by UID 568', () => {
    expect(dockerfile).toContain('chown -R 568:568 /app');
  });

  it('crypto.js keystore path matches Docker mount', () => {
    const cryptoSrc = readSrc('server/crypto.js');
    // crypto.js resolves to ../keystore → /app/keystore in container
    expect(cryptoSrc).toContain("'..', 'keystore'");
  });
});

describe('reset-password.js', () => {
  const src = readSrc('server/reset-password.js');

  it('defines KEYSTORE_DIR', () => {
    expect(src).toContain("const KEYSTORE_DIR = path.resolve(__dirname, '..', 'keystore')");
  });

  it('cleans keystore/ with secure wipe', () => {
    expect(src).toContain('Delete encryption key from keystore/');
    expect(src).toContain('fs.readdirSync(KEYSTORE_DIR)');
    expect(src).toContain('crypto.randomBytes(64)');
  });

  it('also cleans legacy data/.app-secret', () => {
    expect(src).toContain('Delete encryption key from legacy location (data/)');
  });

  it('has consistent step numbering (1-5)', () => {
    expect(src).toContain('// 1. Delete database');
    expect(src).toContain('// 2. Delete encryption key from legacy');
    expect(src).toContain('// 3. Delete encryption key from keystore');
    expect(src).toContain('// 4. Purge logs');
    expect(src).toContain('// 5. Purge screenshots');
  });
});

describe('screenshot cleanup', () => {
  const src = readSrc('server/server.js');

  it('cleanOldScreenshots function exists with 7-day default', () => {
    expect(src).toContain('function cleanOldScreenshots(daysToKeep = 7)');
  });

  it('runs on startup', () => {
    expect(src).toContain('cleanOldScreenshots()');
  });

  it('runs on 24-hour interval', () => {
    expect(src).toContain('setInterval');
    expect(src).toContain('24 * 60 * 60 * 1000');
  });

  it('checks file mtime against cutoff', () => {
    expect(src).toContain('stat.mtimeMs < cutoff');
  });
});

describe('api-config.js credential handling', () => {
  const src = readSrc('server/routes/api-config.js');

  it('resolveCredentials reads encrypted fields', () => {
    const block = src.substring(
      src.indexOf('function resolveCredentials()'),
      src.indexOf('function timeToMinutes(')
    );
    expect(block).toContain("getSetting('freee_username_encrypted')");
    expect(block).not.toContain("getSetting('freee_username')");
    expect(block).toContain('decrypt(freeeUsernameEnc)');
  });

  it('PUT /account encrypts before storing', () => {
    expect(src).toContain("setSetting('freee_username_encrypted', encrypt(username))");
  });

  it('PUT /account clears legacy plaintext', () => {
    expect(src).toContain("setSetting('freee_username', ''); // clear legacy");
  });

  it('DELETE /account clears all credential fields', () => {
    const delBlock = src.substring(
      src.indexOf("router.delete('/account'"),
      src.indexOf("router.post('/verify-credentials'")
    );
    expect(delBlock).toContain("setSetting('freee_username', '')");
    expect(delBlock).toContain("setSetting('freee_username_encrypted', '')");
    expect(delBlock).toContain("setSetting('freee_password_encrypted', '')");
  });
});

describe('automation.js credential handling', () => {
  const src = readSrc('server/automation.js');

  it('getCredentials reads encrypted fields', () => {
    const block = src.substring(
      src.indexOf('function getCredentials()'),
      src.indexOf('/** Get the active connection mode')
    );
    expect(block).toContain("getSetting('freee_username_encrypted')");
    expect(block).not.toContain("getSetting('freee_username')");
    expect(block).toContain('decrypt(dbUsernameEnc)');
    expect(block).toContain('decrypt(dbPasswordEnc)');
  });
});
