import { describe, expect, it } from 'vitest';

import {
  collectLockedArtifacts,
  normalizePolicy,
  validateReleaseAges,
} from '../scripts/ci/dependency-release-age-check.mjs';

const NOW = Date.parse('2026-07-12T00:00:00.000Z');
const TARBALL = 'https://registry.npmjs.org/example/-/example-1.2.3.tgz';

function artifact() {
  return { name: 'example', version: '1.2.3', url: TARBALL, source: 'fixture' };
}

function policy(exceptions = []) {
  return { minimum_age_days: 7, exceptions };
}

function capturedError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to fail');
}

describe('dependency release-age policy', () => {
  it('requires package-lock v3 registry artifacts with SHA-512 integrity', () => {
    const artifacts = collectLockedArtifacts({
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/@scope/example': {
          version: '1.2.3',
          resolved: 'https://registry.npmjs.org/@scope/example/-/example-1.2.3.tgz',
          integrity: 'sha512-YWJjZA==',
        },
      },
    });

    expect(artifacts).toMatchObject([{ name: '@scope/example', version: '1.2.3' }]);
    expect(() => collectLockedArtifacts({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/example': {
          version: '1.2.3',
          resolved: 'https://example.invalid/example.tgz',
          integrity: 'sha512-YWJjZA==',
        },
      },
    })).toThrow(/npm registry tarball/);
  });

  it('accepts artifacts older than the configured window', () => {
    expect(validateReleaseAges({
      artifacts: [artifact()],
      policy: policy(),
      publishedAtByUrl: new Map([[TARBALL, NOW - 8 * 24 * 60 * 60 * 1000]]),
      now: NOW,
    })).toEqual({ artifacts: 1, exceptions: 0 });
  });

  it('rejects young artifacts without an exact exception', () => {
    expect(() => validateReleaseAges({
      artifacts: [artifact()],
      policy: policy(),
      publishedAtByUrl: new Map([[TARBALL, NOW - 2 * 24 * 60 * 60 * 1000]]),
      now: NOW,
    })).toThrow(/rejected 1 artifact/);
  });

  it('accepts only a bounded exact security exception', () => {
    const exception = {
      package: 'example',
      version: '1.2.3',
      expires_at: '2026-07-17',
      advisory_url: 'https://github.com/advisories/GHSA-example',
      statement: 'Required to remediate a published security advisory.',
    };
    expect(validateReleaseAges({
      artifacts: [artifact()],
      policy: policy([exception]),
      publishedAtByUrl: new Map([[TARBALL, NOW - 2 * 24 * 60 * 60 * 1000]]),
      now: NOW,
    })).toEqual({ artifacts: 1, exceptions: 1 });

    expect(() => validateReleaseAges({
      artifacts: [artifact()],
      policy: policy([{ ...exception, expires_at: '2026-08-01' }]),
      publishedAtByUrl: new Map([[TARBALL, NOW - 2 * 24 * 60 * 60 * 1000]]),
      now: NOW,
    })).toThrow(/rejected 1 artifact/);
  });

  it('rejects malformed and stale exceptions', () => {
    for (const expiresAt of ['9999-99-99', '2026-02-30']) {
      expect(() => normalizePolicy(policy([{
        package: 'example',
        version: '1.2.3',
        expires_at: expiresAt,
        advisory_url: 'https://github.com/advisories/GHSA-example',
        statement: 'Required to remediate a published security advisory.',
      }]))).toThrow(/exact, expiring, and justified/);
    }

    for (const advisoryUrl of [
      'http://internal.invalid/advisory',
      'https://internal.invalid/advisory',
      'https://user:password@github.com/advisories/GHSA-example',
      'https://github.com:8443/advisories/GHSA-example',
    ]) {
      expect(() => normalizePolicy(policy([{
        package: 'example',
        version: '1.2.3',
        expires_at: '2026-07-17',
        advisory_url: advisoryUrl,
        statement: 'Required to remediate a published security advisory.',
      }]))).toThrow(/public HTTPS advisory/);
    }

    const error = capturedError(() => validateReleaseAges({
      artifacts: [artifact()],
      policy: policy([{
        package: 'unused',
        version: '9.9.9',
        expires_at: '2026-07-17',
        advisory_url: 'https://osv.dev/vulnerability/EXAMPLE',
        statement: 'Required to remediate a published security advisory.',
      }]),
      publishedAtByUrl: new Map([[TARBALL, NOW - 8 * 24 * 60 * 60 * 1000]]),
      now: NOW,
    }));
    expect(error.blockers).toEqual(['unused@9.9.9: stale release-age exception']);
  });
});
