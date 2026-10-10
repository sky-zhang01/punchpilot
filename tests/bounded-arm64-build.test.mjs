import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'ci', 'build-arm64-image.sh');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runBuild(args, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-arm64-build-'));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  const capturePath = path.join(directory, 'timeout-args.txt');
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(binDirectory, 'timeout'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CAPTURE_PATH"
exit "\${STUB_TIMEOUT_STATUS:-0}"
`);
  fs.writeFileSync(path.join(binDirectory, 'docker'), '#!/usr/bin/env bash\nexit 0\n');
  fs.chmodSync(path.join(binDirectory, 'timeout'), 0o755);
  fs.chmodSync(path.join(binDirectory, 'docker'), 0o755);

  const result = spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      CAPTURE_PATH: capturePath,
      ACTIONS_CACHE_URL: '',
      ACTIONS_RESULTS_URL: '',
      ACTIONS_CACHE_SERVICE_V2: '',
      ACTIONS_RUNTIME_TOKEN: '',
      ...overrides,
    },
  });
  const capturedArgs = fs.existsSync(capturePath)
    ? fs.readFileSync(capturePath, 'utf8').trimEnd().split('\n')
    : [];
  return { ...result, capturedArgs };
}

describe('bounded arm64 container build', () => {
  it('bounds the CI dry run without loading an emulated image', () => {
    const result = runBuild(['ci']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('arm64_build=passed mode=ci');
    expect(result.capturedArgs).toEqual([
      '--signal=TERM',
      '--kill-after=60s',
      '1500s',
      'docker',
      'buildx',
      'build',
      '--platform',
      'linux/arm64',
      '--pull',
      '--no-cache-filter',
      'runtime',
      '--progress',
      'plain',
      '--tag',
      'punchpilot-ci:arm64',
      '.',
    ]);
  });

  it('loads a commit-bound release image for verification', () => {
    const commit = 'a'.repeat(40);
    const result = runBuild(['release', commit], {
      PUNCHPILOT_ARM64_BUILD_TIMEOUT_SECONDS: '900',
    });

    expect(result.status).toBe(0);
    expect(result.capturedArgs).toContain('900s');
    expect(result.capturedArgs).toContain('punchpilot-release-check:arm64');
    expect(result.capturedArgs).toContain(`VCS_REF=${commit}`);
    expect(result.capturedArgs).toContain('--load');
  });

  it('reuses a scoped Actions cache without exposing its credentials', () => {
    const runtimeCredential = String.fromCodePoint(102, 105, 120, 116, 117, 114, 101);
    const result = runBuild(['ci'], {
      ACTIONS_RESULTS_URL: 'https://cache.example.invalid/',
      ACTIONS_CACHE_SERVICE_V2: 'true',
      ACTIONS_RUNTIME_TOKEN: runtimeCredential,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('arm64_build_cache=enabled');
    expect(result.capturedArgs).toContain('type=gha,scope=ci-arm64,timeout=5m');
    expect(result.capturedArgs).toContain(
      'type=gha,scope=ci-arm64,mode=max,ignore-error=true,timeout=5m',
    );
    expect(result.capturedArgs.join('\n')).not.toContain(runtimeCredential);
    expect(result.capturedArgs.join('\n')).not.toContain('cache.example.invalid');
  });

  it('uses the cache endpoint when the runner advertises the first cache protocol', () => {
    const result = runBuild(['ci'], {
      ACTIONS_CACHE_URL: 'https://cache.example.invalid/',
      ACTIONS_RUNTIME_TOKEN: 'fixture',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('arm64_build_cache=enabled');
    expect(result.capturedArgs).toContain('--cache-from');
  });

  it('keeps caching disabled when the results endpoint serves artifacts without a cache', () => {
    const result = runBuild(['ci'], {
      ACTIONS_RESULTS_URL: 'https://gitea.example.invalid/',
      ACTIONS_RUNTIME_TOKEN: 'fixture',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('arm64_build_cache=disabled');
    expect(result.capturedArgs).not.toContain('--cache-from');
    expect(result.capturedArgs).not.toContain('--cache-to');
  });

  it('rejects invalid modes, commit identities, and timeout bounds', () => {
    expect(runBuild(['unknown']).status).toBe(2);
    expect(runBuild(['release', 'not-a-commit']).status).toBe(2);
    expect(runBuild(['ci'], {
      PUNCHPILOT_ARM64_BUILD_TIMEOUT_SECONDS: '59',
    }).status).toBe(2);
  });

  it('returns a stable timeout failure when the watchdog expires', () => {
    const result = runBuild(['ci'], { STUB_TIMEOUT_STATUS: '124' });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('exceeded its 1500-second watchdog');
  });
});
