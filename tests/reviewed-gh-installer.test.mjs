import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/ci/install-reviewed-gh.sh');
const temporaryDirectories = [];
const checksums = {
  amd64_sha256: '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8',
  arm64_sha256: 'b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runInstaller(overrides = {}, args = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-gh-installer-'));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  const runnerTemp = path.join(directory, 'runner');
  const githubPath = path.join(directory, 'github-path');
  const invocation = path.join(directory, 'invocation');
  const architecture = ['arm64', 'aarch64'].includes(overrides.TEST_ARCH) ? 'arm64' : 'amd64';
  const packageName = `gh_2.101.0_linux_${architecture}`;
  const packageBin = path.join(directory, packageName, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(packageBin, { recursive: true });
  fs.writeFileSync(githubPath, '');
  fs.writeFileSync(path.join(packageBin, 'gh'), `#!/usr/bin/env bash
printf 'gh version %s (2026-09-15)\\n' "\${TEST_INSTALLED_VERSION:-2.101.0}"
printf 'executed\\n' >> "$TEST_INVOCATION"
`);
  fs.chmodSync(path.join(packageBin, 'gh'), 0o755);
  const archive = path.join(directory, 'fixture.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', directory, packageName]);
  if (packed.status !== 0) throw new Error(packed.stderr.toString());

  const stubs = {
    uname: `#!/usr/bin/env bash
if [[ $1 == -s ]]; then printf '%s\\n' "$TEST_OS"; else printf '%s\\n' "$TEST_ARCH"; fi
`,
    curl: `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$TEST_CURL_ARGS"
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then cp "$TEST_ARCHIVE" "$2"; exit 0; fi
  shift
done
exit 1
`,
    sha256sum: `#!/usr/bin/env bash
read -r digest archive
[[ $digest == "$TEST_EXPECTED_SHA" && -f $archive && \${TEST_BAD_CHECKSUM:-false} != true ]]
`,
  };
  for (const [name, content] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }
  const curlArgs = path.join(directory, 'curl-args');
  const result = spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_VERSION: '2.101.0',
      RUNNER_TEMP: runnerTemp,
      GITHUB_PATH: githubPath,
      TEST_OS: 'Linux',
      TEST_ARCH: 'x86_64',
      TEST_ARCHIVE: archive,
      TEST_EXPECTED_SHA: checksums[`${architecture}_sha256`],
      TEST_INVOCATION: invocation,
      TEST_CURL_ARGS: curlArgs,
      ...overrides,
    },
  });
  return {
    ...result,
    persistedPath: fs.readFileSync(githubPath, 'utf8').trim(),
    installRoots: fs.readdirSync(runnerTemp),
    wasExecuted: fs.existsSync(invocation),
    curlArgs: fs.existsSync(curlArgs) ? fs.readFileSync(curlArgs, 'utf8') : '',
  };
}

describe('reviewed GitHub CLI installation boundary', () => {
  it.each(['x86_64', 'aarch64', 'arm64'])('installs the reviewed %s archive into the job directory', (architecture) => {
    const result = runInstaller({ TEST_ARCH: architecture });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reviewed_gh_version=2.101.0');
    expect(result.persistedPath).toMatch(/\/runner\/punchpilot-gh\.[^/]+\/bin$/);
    expect(fs.existsSync(path.join(result.persistedPath, 'gh'))).toBe(true);
    expect(result.curlArgs).toContain('--proto-redir\n=https\n');
    expect(result.curlArgs).toContain(`gh_2.101.0_linux_${architecture === 'x86_64' ? 'amd64' : 'arm64'}.tar.gz`);
  });

  it('rejects a mismatched archive before execution and removes its temporary installation', () => {
    const result = runInstaller({ TEST_BAD_CHECKSUM: 'true' });
    expect(result.status).not.toBe(0);
    expect(result.wasExecuted).toBe(false);
    expect(result.persistedPath).toBe('');
    expect(result.installRoots).toEqual([]);
  });

  it('rejects an unexpected installed version before exposing the CLI', () => {
    const result = runInstaller({ TEST_INSTALLED_VERSION: '2.102.0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the reviewed release');
    expect(result.persistedPath).toBe('');
    expect(result.installRoots).toEqual([]);
  });

  it('rejects unreviewed versions, unsupported platforms, and invalid arguments before downloading', () => {
    for (const result of [
      runInstaller({ GH_VERSION: '2.102.0' }),
      runInstaller({ TEST_OS: 'Darwin' }),
      runInstaller({ TEST_ARCH: 'riscv64' }),
      runInstaller({ GITHUB_PATH: '' }),
      runInstaller({}, ['unexpected']),
    ]) {
      expect(result.status).not.toBe(0);
      expect(result.curlArgs).toBe('');
      expect(result.persistedPath).toBe('');
      expect(result.installRoots).toEqual([]);
    }
  });
});
