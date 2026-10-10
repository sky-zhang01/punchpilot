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
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ensureScreenshotsDir,
  SCREENSHOT_ROOT_MARKER,
} from '../server/automation/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('no plaintext freee_username reads in production code', () => {
  const prodFiles = [
    'server/routes/api-config.js',
    'server/automation/utils.js',
    'server/web-account.js',
    'server/freee-api.js',
    'server/scheduler.js',
  ];

  for (const file of prodFiles) {
    it(`${file}: no plaintext credential reads`, () => {
      const src = readSrc(file);
      const lines = src.split('\n');
      const violations = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          /\b(?:getSetting|readSetting)\(\s*(['"])freee_username\1\s*\)/.test(line) &&
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
    'server/automation/public-api.js',
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

  it('Dockerfile creates every private runtime directory with mode 0700', () => {
    expect(dockerfile).toContain(
      'install -d -m 0700 /app/data /app/logs /app/screenshots /app/keystore',
    );
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
    expect(entrypoint).toContain(
      'chmod 700 /app/data /app/logs /app/screenshots /app/keystore',
    );
  });

  it('crypto.js keystore path matches Docker mount', () => {
    expect(readSrc('server/paths.js')).toContain("path.join(root, 'keystore')");
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

  it('only removes expired regular files without following symbolic links', () => {
    expect(src).toMatch(/!stat\.isSymbolicLink\(\)\s*&&\s*stat\.isFile\(\)\s*&&\s*stat\.mtimeMs\s*<\s*cutoff/);
  });

  it('claims an empty private root with a durable ownership marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screenshot-root-'));
    try {
      expect(ensureScreenshotsDir(root)).toBe(path.resolve(root));
      expect(fs.readFileSync(path.join(root, SCREENSHOT_ROOT_MARKER), 'utf8'))
        .toBe('PunchPilot screenshot root v1\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unclaimed directory containing unrelated files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shared-root-'));
    const unrelated = path.join(root, 'unrelated.txt');
    try {
      fs.writeFileSync(unrelated, 'must remain');
      expect(() => ensureScreenshotsDir(root)).toThrowError(
        expect.objectContaining({ code: 'SCREENSHOT_DIRECTORY_UNSAFE' }),
      );
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('must remain');
      expect(fs.existsSync(path.join(root, SCREENSHOT_ROOT_MARKER))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims a private legacy root containing only generated screenshots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-legacy-root-'));
    const identity = `log-v1:${'c'.repeat(64)}`;
    const identityRoot = path.join(root, identity);
    const legacyScreenshots = [
      'checkin-before-2026-07-13T09-50-00.png',
      'login-failed-1783903800000.png',
      'approval-debug-1783903800001.png',
      'verify-1783903800002.png',
      'web-correction-debug-2026-07-13-1783903800003.png',
      'leave-debug-PaidHoliday-2026-07-13-1783903800004.png',
      'withdraw-debug-WorkTime-12345-1783903800005.png',
      'monthly-closing-debug-2026-7-1783903800006.png',
      'monthly-closing-before-2026-7-1783903800007.png',
      'monthly-closing-after-2026-7-1783903800008.png',
    ];
    try {
      fs.chmodSync(root, 0o755);
      for (const filename of legacyScreenshots) {
        fs.writeFileSync(path.join(root, filename), 'synthetic image bytes');
      }
      fs.mkdirSync(identityRoot, { mode: 0o755 });
      fs.writeFileSync(
        path.join(identityRoot, 'checkin-after-2026-07-13T09-50-01-000.png'),
        'synthetic image bytes',
      );
      expect(ensureScreenshotsDir(root)).toBe(path.resolve(root));
      for (const filename of legacyScreenshots) {
        expect(fs.existsSync(path.join(root, filename))).toBe(true);
      }
      expect(fs.existsSync(path.join(root, SCREENSHOT_ROOT_MARKER))).toBe(true);
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(identityRoot).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not change permissions when a legacy-root claim fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shared-legacy-root-'));
    const identityRoot = path.join(root, `log-v1:${'d'.repeat(64)}`);
    const unrelated = path.join(root, 'zz-unrelated.txt');
    try {
      fs.chmodSync(root, 0o755);
      fs.mkdirSync(identityRoot, { mode: 0o755 });
      fs.writeFileSync(
        path.join(identityRoot, 'checkin-after-2026-07-13T09-50-01-000.png'),
        'synthetic image bytes',
      );
      fs.writeFileSync(unrelated, 'must remain');

      expect(() => ensureScreenshotsDir(root)).toThrowError(
        expect.objectContaining({ code: 'SCREENSHOT_DIRECTORY_UNSAFE' }),
      );
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
      expect(fs.statSync(identityRoot).mode & 0o777).toBe(0o755);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('must remain');
      expect(fs.existsSync(path.join(root, SCREENSHOT_ROOT_MARKER))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link ownership marker without following it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-marker-root-'));
    const outside = path.join(os.tmpdir(), `pp-marker-target-${process.pid}`);
    try {
      fs.writeFileSync(outside, 'PunchPilot screenshot root v1\n');
      fs.symlinkSync(outside, path.join(root, SCREENSHOT_ROOT_MARKER));
      expect(() => ensureScreenshotsDir(root)).toThrowError(
        expect.objectContaining({ code: 'SCREENSHOT_DIRECTORY_UNSAFE' }),
      );
      expect(fs.readFileSync(outside, 'utf8'))
        .toBe('PunchPilot screenshot root v1\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('bounded shutdown', () => {
  const src = readSrc('server/server.js');

  it('keeps a referenced hard-exit timer around every graceful shutdown', () => {
    expect(src).toContain('SHUTDOWN_FORCE_EXIT_BUFFER_MS');
    expect(src).toContain('Hard shutdown deadline expired; terminating the process');
    expect(src).toContain('process.exit(forcedExitCode)');
  });

  it('bounds browser close and reacts to an unrecoverable automation runtime', () => {
    expect(src).toContain('completionWithin(\n      automationRuntime.close()');
    expect(src).toContain("process.on('punchpilot:automation-unrecoverable'");
    expect(src).toContain("shutdown('automationRuntimeFailure', 1)");
  });
});

describe('Reverse Proxy Support (v0.4.2)', () => {
  const appSrc = readSrc('server/app.js');
  const authSrc = readSrc('server/auth.js');

  it('UT-TP-08: proxy trust is explicit and disabled by default', () => {
    expect(appSrc).toContain("process.env.TRUST_PROXY");
    expect(appSrc).toContain("app.set('trust proxy', configuredTrustProxy())");
    expect(appSrc).toContain("if (!value?.trim()) return false");
    expect(appSrc).not.toContain("app.set('trust proxy', 1)");
  });

  it('UT-TP-09: session cookies use the canonical secure transport decision', () => {
    const cookieBlock = authSrc.substring(
      authSrc.indexOf('function sessionCookieOptions'),
      authSrc.indexOf('/**\n * Extract session token'),
    );
    expect(cookieBlock).toContain('secure: requestUsesSecureTransport(req)');
    expect(cookieBlock).toContain("path: '/'");
    expect(cookieBlock).not.toContain('isProduction');
  });

  it('UT-SEC-05: HSTS uses the canonical secure transport decision', () => {
    expect(appSrc).toContain('requestUsesSecureTransport(req)');
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

  it('PUT /account encrypts before storing', () => {
    const accountBlock = src.substring(
      src.indexOf("router.put('/account'"),
      src.indexOf("router.delete('/account'"),
    );
    expect(accountBlock).toContain("const normalizedUsername = typeof username === 'string' ? username.trim() : ''");
    expect(accountBlock).toContain('setSettingsAtomically([');
    expect(accountBlock).toContain(
      "['freee_username_encrypted', encrypt(normalizedUsername)]",
    );
    expect(accountBlock).toContain(
      "['freee_password_encrypted', encrypt(password)]",
    );
    expect(accountBlock).not.toContain("['freee_username', normalizedUsername]");
    expect(accountBlock).not.toContain("['freee_username_encrypted', encrypt(username)]");
  });

  it('PUT /account clears legacy plaintext', () => {
    const accountBlock = src.substring(
      src.indexOf("router.put('/account'"),
      src.indexOf("router.delete('/account'"),
    );
    expect(accountBlock).toContain("['freee_username', '']");
  });

  it('DELETE /account clears all credential fields', () => {
    const delBlock = src.substring(
      src.indexOf("router.delete('/account'"),
      src.indexOf("router.post('/verify-credentials'")
    );
    expect(delBlock).toContain('setSettingsAtomically([');
    expect(delBlock).toContain("['freee_username', '']");
    expect(delBlock).toContain("['freee_username_encrypted', '']");
    expect(delBlock).toContain("['freee_password_encrypted', '']");
    expect(delBlock).toContain("['web_employee_id_encrypted', '']");
  });
});
