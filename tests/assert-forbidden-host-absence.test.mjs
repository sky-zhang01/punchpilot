import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseForbiddenHosts,
  buildHostRegexes,
  runAbsenceCheck,
} from '../scripts/ci/assert-forbidden-host-absence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(root, 'scripts', 'ci', 'assert-forbidden-host-absence.mjs');

describe('assert-forbidden-host-absence', () => {
  describe('parseForbiddenHosts', () => {
    it('returns null for missing, empty, or whitespace strings', () => {
      expect(parseForbiddenHosts(undefined)).toBeNull();
      expect(parseForbiddenHosts('')).toBeNull();
      expect(parseForbiddenHosts('   ')).toBeNull();
      expect(parseForbiddenHosts(' , ,, ')).toBeNull();
    });

    it('parses and normalizes single and multiple hosts', () => {
      expect(parseForbiddenHosts('Sub.Example.COM')).toEqual(['sub.example.com']);
      expect(parseForbiddenHosts('*.sub.example.com, foo.bar.net')).toEqual([
        'sub.example.com',
        'foo.bar.net',
      ]);
    });
  });

  describe('buildHostRegexes', () => {
    it('matches literal, split array, string concat, and encoded forms', () => {
      const [regex] = buildHostRegexes('alpha.beta.gamma.net');
      expect(regex).toBeDefined();

      const testCases = [
        'alpha.beta.gamma.net',
        "['alpha', 'beta', 'gamma', 'net'].join('.')",
        '["alpha", "beta", "gamma", "net"]',
        "'alpha.' + 'beta.' + 'gamma.net'",
        "'alpha' + '.' + 'beta' + '.' + 'gamma' + '.' + 'net'",
        'alpha%2ebeta\\x2egamma\\u002enet',
        'alpha\\056beta.gamma.net',
      ];

      for (const tc of testCases) {
        expect(regex.test(tc), `expected regex to match: ${tc}`).toBe(true);
      }
    });

    it('rejects unrelated hostnames or partial label matches', () => {
      const [regex] = buildHostRegexes('alpha.beta.gamma.net');
      const negCases = [
        'alpha.beta.other.net',
        'subalpha.beta.gamma.net',
        'alpha.beta.gamma.netextra',
        'unrelated.domain.com',
      ];

      for (const tc of negCases) {
        expect(regex.test(tc), `expected regex NOT to match: ${tc}`).toBe(false);
      }
    });
  });

  describe('fail-closed contract', () => {
    it('fails closed when PUBLIC_RELEASE_FORBIDDEN_HOSTS is missing or empty', () => {
      const result = runAbsenceCheck({ hostsEnv: '', silent: true });
      expect(result.success).toBe(false);
      expect(result.reason).toBe('FAIL_CLOSED');
    });

    it('returns exit code 1 via CLI when PUBLIC_RELEASE_FORBIDDEN_HOSTS is missing', () => {
      try {
        execFileSync(process.execPath, [scriptPath], {
          cwd: root,
          env: { ...process.env, PUBLIC_RELEASE_FORBIDDEN_HOSTS: '' },
          encoding: 'utf8',
        });
        expect.unreachable('CLI should have exited with code 1');
      } catch (err) {
        expect(err.status).toBe(1);
        expect(err.stderr).toContain('PUBLIC_RELEASE_FORBIDDEN_HOSTS is required');
      }
    });
  });

  describe('red/green detection contract', () => {
    it('passes when no forbidden host pattern exists in the workspace', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absence-clean-test-'));
      const testHost = 'fixture.fixture.invalid';
      try {
        fs.writeFileSync(path.join(tempDir, 'sample.js'), 'const a = 123;\nconsole.log(a);\n');

        const result = runAbsenceCheck({
          root: tempDir,
          hostsEnv: testHost,
          silent: true,
        });
        expect(result.success).toBe(true);
        expect(result.reason).toBe('CLEAN');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('detects temporary split-assembled host fixture (red/green test)', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'absence-redgreen-test-'));
      const fixturePath = path.join(tempDir, 'fixture.js');
      const targetHost = 'fixture.fixture.invalid';
      const label1 = 'fixture';
      const label2 = 'fixture';
      const label3 = 'invalid';

      try {
        // Red test: file contains array-split assembly form
        fs.writeFileSync(
          fixturePath,
          `const domain = ['${label1}', '${label2}', '${label3}'].join('.');\n`,
        );

        const redResult = runAbsenceCheck({
          root: tempDir,
          hostsEnv: targetHost,
          silent: true,
        });

        expect(redResult.success).toBe(false);
        expect(redResult.reason).toBe('FORBIDDEN_HOST_DETECTED');
        expect(redResult.findings.some((f) => f.file.includes('fixture.js'))).toBe(true);

        // Green test: fixture removed
        fs.unlinkSync(fixturePath);

        const greenResult = runAbsenceCheck({
          root: tempDir,
          hostsEnv: targetHost,
          silent: true,
        });
        expect(greenResult.success).toBe(true);
        expect(greenResult.reason).toBe('CLEAN');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
