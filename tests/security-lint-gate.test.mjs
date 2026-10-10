import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildSecurityLintSnapshot,
  compareBaselineDocuments,
  parseCanonicalBaseline,
  runSecurityLintGate,
  updateSecurityLintBaseline,
  validateBaselineDocument,
} from '../scripts/ci/security-lint-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CONFIG_URL = pathToFileURL(path.join(ROOT, 'eslint.config.mjs')).href;
const LOW_CONFIDENCE_SOURCE = `export function readValue(object, key) {
  return object[key];
}
`;

function warning(overrides = {}) {
  return {
    path: 'server/example.js',
    rule: 'security/detect-object-injection',
    message: 'Generic Object Injection Sink',
    source_line_sha256: 'a'.repeat(64),
    source_file_sha256: 'b'.repeat(64),
    column: 7,
    occurrence: 1,
    ...overrides,
  };
}

function document(overrides = {}) {
  return {
    schema_version: 2,
    eslint_version: '10.6.0',
    plugin_security_version: '4.0.1',
    config_sha256: 'c'.repeat(64),
    warnings: [warning()],
    ...overrides,
  };
}

function createFixture(source = LOW_CONFIDENCE_SOURCE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-security-lint-'));
  fs.mkdirSync(path.join(root, 'server'));
  fs.writeFileSync(
    path.join(root, 'eslint.config.mjs'),
    `export { default } from ${JSON.stringify(ROOT_CONFIG_URL)};\n`,
  );
  fs.writeFileSync(path.join(root, 'server', 'probe.js'), source);
  return root;
}

async function withFixture(source, operation) {
  const root = createFixture(source);
  try {
    return await operation(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('security lint baseline gate', () => {
  it('rejects a one-for-one warning replacement even when the count is unchanged', () => {
    const expected = document();
    const current = document({
      warnings: [warning({ source_line_sha256: 'd'.repeat(64) })],
    });

    try {
      compareBaselineDocuments(expected, current);
      throw new Error('Expected warning replacement to fail');
    } catch (error) {
      expect(error.blockers).toHaveLength(2);
      expect(error.blockers).toEqual(expect.arrayContaining([
        expect.stringMatching(/^new warning:/),
        expect.stringMatching(/^stale warning:/),
      ]));
    }
  });

  it('rejects stale findings and configuration or whole-source drift', () => {
    expect(() => compareBaselineDocuments(
      document(),
      document({ warnings: [] }),
    )).toThrow(/rejected 1 change/);

    for (const current of [
      document({ config_sha256: 'd'.repeat(64) }),
      document({ warnings: [warning({ source_file_sha256: 'd'.repeat(64) })] }),
    ]) {
      expect(() => compareBaselineDocuments(document(), current)).toThrow(/rejected/);
    }
  });

  it('records toolchain versions as provenance without blocking on their drift', () => {
    for (const current of [
      document(),
      document({ eslint_version: '10.7.0' }),
      document({ plugin_security_version: '4.0.2' }),
      document({ eslint_version: '10.7.0', plugin_security_version: '4.0.2' }),
    ]) {
      expect(() => compareBaselineDocuments(document(), current)).not.toThrow();
    }

    // The fields must still exist and stay well-formed provenance metadata.
    for (const field of ['eslint_version', 'plugin_security_version']) {
      expect(() => validateBaselineDocument(document({ [field]: 'not-a-version' })))
        .toThrow(new RegExp(`${field} is invalid`));
      expect(() => validateBaselineDocument(document({ [field]: undefined })))
        .toThrow(new RegExp(`${field} is invalid`));
    }
    // Provenance drift alone must not hide a blocking change in the same run.
    expect(() => compareBaselineDocuments(
      document(),
      document({ eslint_version: '10.7.0', config_sha256: 'd'.repeat(64) }),
    )).toThrow(/rejected 1 change/);
  });

  it('requires canonical, repo-relative, unique, low-confidence records', () => {
    expect(() => validateBaselineDocument(document({
      warnings: [warning({ path: path.join(ROOT, 'server', 'example.js') })],
    }))).toThrow(/repo-relative/);

    const duplicateField = canonicalJson(document())
      .replace('"schema_version": 2', '"schema_version": 2,\n  "schema_version": 2');
    expect(() => parseCanonicalBaseline(duplicateField)).toThrow(/canonical JSON/);

    expect(() => validateBaselineDocument(document({
      warnings: [warning(), warning()],
    }))).toThrow(/duplicates another finding identity/);

    expect(() => validateBaselineDocument(document({
      warnings: [{
        rule: 'security/detect-object-injection',
        path: 'server/example.js',
        message: 'Generic Object Injection Sink',
        source_line_sha256: 'a'.repeat(64),
        source_file_sha256: 'b'.repeat(64),
        column: 7,
        occurrence: 1,
      }],
    }))).toThrow(/non-canonical fields/);

    expect(() => validateBaselineDocument(document({
      warnings: [warning({ rule: 'security/detect-child-process' })],
    }))).toThrow(/high-confidence security rule/);

    expect(() => validateBaselineDocument(document({
      warnings: [
        warning({ path: 'server/z.js' }),
        warning({ path: 'server/a.js', source_line_sha256: 'd'.repeat(64) }),
      ],
    }))).toThrow(/canonical order/);
  });

  it('keeps low-confidence findings active when source tries to turn them off', async () => {
    await withFixture(
      `/* eslint security/detect-object-injection: off */\n${LOW_CONFIDENCE_SOURCE}`,
      async (root) => {
        const snapshot = await buildSecurityLintSnapshot(root);
        expect(snapshot.document.warnings).toHaveLength(1);
        expect(snapshot.document.warnings[0].rule)
          .toBe('security/detect-object-injection');
      },
    );
  });

  it.each(['warn', 'off'])(
    'keeps high-confidence findings as errors when source requests %s',
    async (severity) => {
      const source = `/* eslint security/detect-child-process: ${severity} */
import child from 'node:child_process';
export function run(command) { return child.exec(command); }
`;
      await withFixture(source, async (root) => {
        await expect(buildSecurityLintSnapshot(root))
          .rejects.toThrow(/Security lint error at server\/probe\.js:3:/);
      });
    },
  );

  it('binds each finding to surrounding source context, not only the sink line', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const first = await buildSecurityLintSnapshot(root);
      fs.writeFileSync(
        path.join(root, 'server', 'probe.js'),
        `// Context-only change.\n${LOW_CONFIDENCE_SOURCE}`,
      );
      const second = await buildSecurityLintSnapshot(root);

      expect(second.document.warnings[0].source_line_sha256)
        .toBe(first.document.warnings[0].source_line_sha256);
      expect(second.document.warnings[0].source_file_sha256)
        .not.toBe(first.document.warnings[0].source_file_sha256);
      try {
        compareBaselineDocuments(
          first.document,
          second.document,
          second.diagnostics,
        );
        throw new Error('Expected context-only change to fail');
      } catch (error) {
        expect(error.message).toMatch(/rejected 2 change/);
        expect(error.blockers).toEqual(expect.arrayContaining([
          expect.stringContaining(
            `file=${first.document.warnings[0].source_file_sha256.slice(0, 12)}`,
          ),
          expect.stringContaining(
            `file=${second.document.warnings[0].source_file_sha256.slice(0, 12)}`,
          ),
        ]));
      }
    });
  });

  it('rejects symbolic-link configuration and baseline inputs', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const configPath = path.join(root, 'eslint.config.mjs');
      fs.unlinkSync(configPath);
      fs.symlinkSync(path.join(ROOT, 'eslint.config.mjs'), configPath);
      await expect(buildSecurityLintSnapshot(root))
        .rejects.toThrow(/configuration must be a regular repository file/);
    });

    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const snapshot = await buildSecurityLintSnapshot(root);
      const target = path.join(root, 'baseline-target.json');
      fs.writeFileSync(target, canonicalJson(snapshot.document));
      fs.symlinkSync(target, path.join(root, 'security-lint-baseline.json'));
      await expect(runSecurityLintGate(root))
        .rejects.toThrow(/baseline must be a regular repository file/);
    });
  });

  it('regenerates a canonical baseline that the gate then accepts', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      await expect(runSecurityLintGate(root))
        .rejects.toThrow(/baseline must be a readable repository file/);

      const result = await updateSecurityLintBaseline(root);
      expect(result.created).toBe(true);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toBe(1);

      const written = fs.readFileSync(
        path.join(root, 'security-lint-baseline.json'),
        'utf8',
      );
      const baseline = parseCanonicalBaseline(written);
      const current = await buildSecurityLintSnapshot(root);
      expect(baseline).toEqual(current.document);
      expect(written).toBe(canonicalJson(current.document));
      expect(await runSecurityLintGate(root)).toEqual({ warnings: 1 });
    });
  });

  it('reports reviewed drift when regenerating a stale baseline', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const current = await buildSecurityLintSnapshot(root);
      fs.writeFileSync(
        path.join(root, 'security-lint-baseline.json'),
        canonicalJson({ ...current.document, config_sha256: 'd'.repeat(64) }),
      );

      const result = await updateSecurityLintBaseline(root);
      expect(result.created).toBe(false);
      expect(result.changes).toEqual([
        'config_sha256 drifted from the reviewed baseline',
      ]);
      expect(await runSecurityLintGate(root)).toEqual({ warnings: 1 });
      const baseline = parseCanonicalBaseline(
        fs.readFileSync(path.join(root, 'security-lint-baseline.json'), 'utf8'),
      );
      expect(baseline.config_sha256).toBe(current.document.config_sha256);
    });
  });

  it('passes the gate on toolchain-version-only drift and refreshes provenance', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const current = await buildSecurityLintSnapshot(root);
      fs.writeFileSync(
        path.join(root, 'security-lint-baseline.json'),
        canonicalJson({
          ...current.document,
          eslint_version: '10.6.0',
          plugin_security_version: '4.0.0',
        }),
      );

      expect(await runSecurityLintGate(root)).toEqual({ warnings: 1 });

      const result = await updateSecurityLintBaseline(root);
      expect(result.created).toBe(false);
      expect(result.changes).toEqual([
        'eslint_version provenance refreshed (non-blocking)',
        'plugin_security_version provenance refreshed (non-blocking)',
      ]);
      const baseline = parseCanonicalBaseline(
        fs.readFileSync(path.join(root, 'security-lint-baseline.json'), 'utf8'),
      );
      expect(baseline.eslint_version).toBe(current.document.eslint_version);
      expect(baseline.plugin_security_version)
        .toBe(current.document.plugin_security_version);
      expect(await runSecurityLintGate(root)).toEqual({ warnings: 1 });
    });
  });

  it('refuses to rewrite the baseline through a symbolic link', async () => {
    await withFixture(LOW_CONFIDENCE_SOURCE, async (root) => {
      const snapshot = await buildSecurityLintSnapshot(root);
      const target = path.join(root, 'baseline-target.json');
      fs.writeFileSync(target, canonicalJson(snapshot.document));
      fs.symlinkSync(target, path.join(root, 'security-lint-baseline.json'));
      await expect(updateSecurityLintBaseline(root))
        .rejects.toThrow(/baseline must be a regular repository file/);
    });
  });

  it('exposes the rebaseline path only through the documented CLI flag', () => {
    const output = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'security-lint-gate.mjs'), '--bogus'],
      { encoding: 'utf8' },
    );
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('Usage: security-lint-gate.mjs [--print-baseline|--update]');
  });

  it('matches the committed baseline to the complete current server source set', async () => {
    const baselineText = fs.readFileSync(path.join(ROOT, 'security-lint-baseline.json'), 'utf8');
    const baseline = parseCanonicalBaseline(baselineText);
    const current = await buildSecurityLintSnapshot(ROOT);

    expect(compareBaselineDocuments(
      baseline,
      current.document,
      current.diagnostics,
    )).toEqual({ warnings: baseline.warnings.length });
    expect(baselineText).not.toContain(ROOT);
    expect(baseline).not.toHaveProperty('suppressions');
    expect(baseline.eslint_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseline.plugin_security_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(baseline.warnings[0])).toEqual([
      'path',
      'rule',
      'message',
      'source_line_sha256',
      'source_file_sha256',
      'column',
      'occurrence',
    ]);

    const duplicateLocations = baseline.warnings.filter((entry) =>
      entry.path === 'server/automation/scheduling.js' &&
      entry.rule === 'security/detect-object-injection' &&
      entry.column === 7);
    expect(duplicateLocations.map((entry) => entry.occurrence)).toEqual([1, 2]);
  });
});
