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

  it('uses entrypoint with PUID/PGID support for non-root execution', () => {
    expect(dockerfile).toContain('ENTRYPOINT');
    expect(dockerfile).toContain('docker-entrypoint.sh');
    expect(dockerfile).toContain('gosu');
  });

  it('entrypoint script handles UID/GID switching', () => {
    const entrypoint = readSrc('docker-entrypoint.sh');
    expect(entrypoint).toContain('PUID');
    expect(entrypoint).toContain('PGID');
    expect(entrypoint).toContain('chown');
    expect(entrypoint).toContain('gosu');
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

describe('Reverse Proxy Support (v0.4.2)', () => {
  const appSrc = readSrc('server/app.js');
  const authSrc = readSrc('server/auth.js');

  it('UT-TP-08: app.js sets trust proxy to 1', () => {
    expect(appSrc).toContain("app.set('trust proxy', 1)");
  });

  it('UT-TP-09: auth.js loginHandler uses req.protocol for cookie secure', () => {
    // Find the loginHandler function and check it uses req.protocol
    const loginBlock = authSrc.substring(
      authSrc.indexOf('loginHandler'),
      authSrc.indexOf('changePasswordHandler')
    );
    expect(loginBlock).toContain("req.protocol === 'https'");
    expect(loginBlock).not.toContain('isProduction');
  });

  it('UT-TP-10: auth.js changePasswordHandler uses req.protocol for cookie secure', () => {
    const cpBlock = authSrc.substring(
      authSrc.indexOf('changePasswordHandler')
    );
    expect(cpBlock).toContain("req.protocol === 'https'");
    expect(cpBlock).not.toContain('isProduction');
  });

  it('UT-SEC-05: HSTS header sent only when req.protocol is https', () => {
    expect(appSrc).toContain("req.protocol === 'https'");
    expect(appSrc).toContain('Strict-Transport-Security');
  });

  it('UT-SEC-06: HSTS max-age is at least 1 year', () => {
    expect(appSrc).toContain('max-age=31536000');
  });

  it('UT-SEC-07: HSTS includes includeSubDomains', () => {
    expect(appSrc).toContain('includeSubDomains');
  });

  it('UT-DOCKER-07: docker-compose.yml does not set NODE_ENV', () => {
    const compose = readSrc('docker-compose.yml');
    expect(compose).not.toContain('NODE_ENV');
  });
});

describe('v0.4.2: Async Batch Task Implementation', () => {
  const attendanceSrc = readSrc('server/routes/api-attendance.js');
  const apiTsSrc = readSrc('client/src/api.ts');

  it('UT-AT-01: api-attendance.js has asyncTasks Map', () => {
    expect(attendanceSrc).toContain('const asyncTasks = new Map()');
  });

  it('UT-AT-02: Task ID uses crypto.randomUUID()', () => {
    expect(attendanceSrc).toContain('crypto.randomUUID()');
  });

  it('UT-AT-03: Task TTL is 30 minutes', () => {
    expect(attendanceSrc).toContain('30 * 60 * 1000');
  });

  it('UT-AT-04: GET /batch/status/:taskId endpoint exists', () => {
    expect(attendanceSrc).toContain("router.get('/batch/status/:taskId'");
  });

  it('UT-AT-05: POST /batch returns task_id immediately', () => {
    expect(attendanceSrc).toContain("res.json({ task_id: taskId, status: 'running' })");
  });

  it('UT-AT-06: POST /batch-leave-request returns task_id', () => {
    // Same async pattern used for leave requests
    const batchLeaveBlock = attendanceSrc.substring(attendanceSrc.indexOf("'/batch-leave-request'"));
    expect(batchLeaveBlock).toContain('task_id');
  });

  it('UT-AT-07: POST /batch-withdraw returns task_id', () => {
    const batchWithdrawBlock = attendanceSrc.substring(attendanceSrc.indexOf("'/batch-withdraw'"));
    expect(batchWithdrawBlock).toContain('task_id');
  });

  it('UT-AT-10: api.ts has pollTask function', () => {
    expect(apiTsSrc).toContain('async function pollTask');
  });

  it('UT-AT-11: api.ts has asyncBatchRequest function', () => {
    expect(apiTsSrc).toContain('async function asyncBatchRequest');
  });

  it('UT-AT-12: submitBatch uses asyncBatchRequest', () => {
    expect(apiTsSrc).toContain("asyncBatchRequest('/attendance/batch'");
  });
});

describe('Version Consistency', () => {
  const expectedVersion = JSON.parse(readSrc('package.json')).version;

  it('UT-VER-01: package.json version is defined', () => {
    expect(expectedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('UT-VER-02: client/package.json version matches root', () => {
    const pkg = JSON.parse(readSrc('client/package.json'));
    expect(pkg.version).toBe(expectedVersion);
  });

  it('UT-VER-03: Dockerfile has matching version label', () => {
    const dockerfile = readSrc('Dockerfile');
    expect(dockerfile).toContain(expectedVersion);
  });

  it('UT-VER-04: CHANGELOG.md has matching version section', () => {
    const changelog = readSrc('CHANGELOG.md');
    expect(changelog).toContain(`[${expectedVersion}]`);
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
