import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceWorkflowAvailability = [
  'internal-release-check.yml',
  'ci.yml',
  'branch-housekeeping.yml',
].map((name) => fs.existsSync(path.join(root, '.gitea', 'workflows', name)));
const sourceWorkflowsAvailable = sourceWorkflowAvailability.every(Boolean);
const anySourceWorkflowAvailable = sourceWorkflowAvailability.some(Boolean);
const sourcePolicyAvailable = fs.existsSync(
  path.join(root, '.public-export', 'allowlist.json'),
);
const sourceIt = sourceWorkflowsAvailable ? it : it.skip;
const reviewedNodeVersion = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();

function workflow(directory, name) {
  return fs.readFileSync(path.join(root, directory, 'workflows', name), 'utf8');
}

function stepOffset(source, name) {
  const offset = source.indexOf(`- name: ${name}`);
  expect(offset, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return offset;
}

function jobSection(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  expect(start, `missing workflow job: ${name}`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1
    ? source.slice(start)
    : source.slice(start, start + marker.length + nextJob);
}

function stepRun(source, name) {
  const offset = stepOffset(source, name);
  const nextStep = source.slice(offset + 1).search(/^      - /m);
  const step = nextStep < 0 ? source.slice(offset) : source.slice(offset, offset + 1 + nextStep);
  const block = step.match(/^        run: \|\n([\s\S]*)/m);
  if (block) return block[1].split('\n').map((line) => line.slice(10)).join('\n');
  const scalar = step.match(/^        run: (.+)$/m);
  expect(scalar, `missing run for ${name}`).not.toBeNull();
  return scalar[1];
}

function recoveryFixture() {
  const amd64 = `sha256:${'a'.repeat(64)}`, arm64 = `sha256:${'b'.repeat(64)}`;
  const amd64Config = `sha256:${'c'.repeat(64)}`, arm64Config = `sha256:${'d'.repeat(64)}`;
  return {
    index: { schemaVersion: 2, manifests: [
      { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: arm64, platform: { os: 'linux', architecture: 'arm64' } },
    ] },
    manifests: { [amd64]: { config: { digest: amd64Config } }, [arm64]: { config: { digest: arm64Config } } },
    images: {
      amd64: { id: amd64Config, architecture: 'amd64', revision: 'e'.repeat(40) },
      arm64: { id: arm64Config, architecture: 'arm64', revision: 'e'.repeat(40) },
    },
  };
}

function runRecoveryStep(name, fixture, values = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-workflow-recovery-'));
  fs.chmodSync(directory, 0o700);
  try {
    const indexBytes = `${JSON.stringify(fixture.index)}\n`;
    const manifestDigest = `sha256:${createHash('sha256').update(indexBytes).digest('hex')}`;
    fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify(fixture));
    const mock = String.raw`
      import fs from 'node:fs';
      const fixture = JSON.parse(fs.readFileSync(process.env.TEST_FIXTURE));
      const [command, ...args] = process.argv.slice(2);
      const calls = fs.existsSync(process.env.TEST_CALLS) ? JSON.parse(fs.readFileSync(process.env.TEST_CALLS)) : [];
      calls.push({ command, args }); fs.writeFileSync(process.env.TEST_CALLS, JSON.stringify(calls));
      const reply = (value) => process.stdout.write(JSON.stringify(value) + '\n');
      if (command === 'gh') {
        if (args[0] === 'attestation' && args[1] === 'verify') {
          if (fixture.invalidSignature) process.exit(17);
          reply([{}]);
        } else if (args[0] === 'api') {
          const endpoint = args[1];
          if (endpoint.endsWith('/commits/main')) process.stdout.write('e'.repeat(40) + '\n');
          else if (endpoint.includes('/git/ref/tags/')) reply({ object: { type: 'tag', sha: 'f'.repeat(40) } });
          else if (endpoint.includes('/git/tags/')) reply({ object: { type: 'commit', sha: 'e'.repeat(40) } });
          else if (endpoint.includes('/actions/workflows/ci.yml/runs')) reply({ workflow_runs: [{ head_sha: 'e'.repeat(40), event: 'push', head_branch: 'main', run_number: 1, run_attempt: 1, id: 1, status: 'completed', conclusion: 'success' }] });
          else process.exit(94);
        } else process.exit(94);
      } else if (command === 'docker') {
        if (args.slice(0,3).join(' ') === 'buildx imagetools inspect') {
          const reference = args.at(-1);
          if (reference.endsWith(':0.5.0')) {
            if (fixture.registryError) { process.stderr.write(fixture.registryError + '\n'); process.exit(1); }
            reply(fixture.index);
          } else {
            const manifest = fixture.manifests[reference.split('@')[1]];
            if (!manifest) process.exit(93);
            reply(manifest);
          }
        } else if (args.slice(0,2).join(' ') === 'image inspect') {
          const reference = args[2];
          const architecture = reference.endsWith(':amd64') || reference.endsWith('a'.repeat(64)) ? 'amd64' : 'arm64';
          const image = fixture.images[architecture];
          const format = args.at(-1);
          process.stdout.write((format === '{{.Id}}' ? image.id : format === '{{.Architecture}}' ? image.architecture : image.revision) + '\n');
        } else if (!['pull', 'tag'].includes(args[0])) process.exit(92);
      } else process.exit(91);
    `;
    fs.writeFileSync(path.join(directory, 'mock.mjs'), mock);
    for (const command of ['docker', 'gh']) {
      fs.writeFileSync(path.join(directory, command), `#!/bin/sh\nexec "$TEST_NODE" "$TEST_MOCK" ${command} "$@"\n`, { mode: 0o700 });
    }
    const source = workflow('.github', 'docker-publish.yml');
    const script = stepRun(source, name).replaceAll('/tmp/', `${directory}/`);
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: directory, encoding: 'utf8', env: {
        PATH: `${directory}:${process.env.PATH}`, TEST_NODE: process.execPath,
        TEST_MOCK: path.join(directory, 'mock.mjs'), TEST_FIXTURE: path.join(directory, 'fixture.json'),
        TEST_CALLS: path.join(directory, 'calls.json'), GITHUB_OUTPUT: path.join(directory, 'output'),
        REGISTRY: 'ghcr.io', IMAGE_NAME: 'sky-zhang01/punchpilot', GITHUB_REPOSITORY: 'sky-zhang01/punchpilot',
        GITHUB_REF_NAME: 'v0.5.0', GITHUB_REF: 'refs/tags/v0.5.0', EXPECTED_COMMIT: 'e'.repeat(40),
        EXPECTED_TAG_OBJECT: 'f'.repeat(40), RECOVERY_MODE: 'true', RECOVERY_MANIFEST_DIGEST: manifestDigest,
        RECOVERY_AMD64_DIGEST: fixture.index.manifests[0].digest, RECOVERY_ARM64_DIGEST: fixture.index.manifests[1].digest,
        ...values,
      },
    });
    return { ...result,
      output: fs.existsSync(path.join(directory, 'output')) ? fs.readFileSync(path.join(directory, 'output'), 'utf8') : '',
      calls: fs.existsSync(path.join(directory, 'calls.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'calls.json'))) : [],
    };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe('executed immutable release recovery steps', () => {
  const recovery = 'Recover signed immutable candidates before rebuilding';
  const inspect = 'Inspect resumable release state before registry write';

  it('restores signed existing images into a fresh current-attempt producer', () => {
    const result = runRecoveryStep(recovery, recoveryFixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('resume=true');
    const verifications = result.calls.filter((call) => call.command === 'gh');
    expect(verifications).toHaveLength(2);
    for (const { args } of verifications) {
      expect(args).toContain('--deny-self-hosted-runners');
      expect(args).toContain('https://cyclonedx.org/bom');
      expect(args.slice(args.indexOf('--source-digest'), args.indexOf('--source-digest') + 2)).toEqual(['--source-digest', 'e'.repeat(40)]);
      expect(args.slice(args.indexOf('--signer-digest'), args.indexOf('--signer-digest') + 2)).toEqual(['--signer-digest', 'e'.repeat(40)]);
      expect(args).toContain('sky-zhang01/punchpilot/.github/workflows/docker-publish.yml');
      expect(args).toContain('refs/tags/v0.5.0');
    }
    expect(result.calls.filter(({ command, args }) => command === 'docker' && args[0] === 'tag')).toHaveLength(2);
    expect(result.calls.some(({ args }) => args[0] === 'push' || args.includes('create'))).toBe(false);
  });

  it('builds fresh only for a definite missing version', () => {
    const fixture = recoveryFixture(); fixture.registryError = 'ERROR: ghcr.io/sky-zhang01/punchpilot:0.5.0: not found';
    const result = runRecoveryStep(recovery, fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('resume=false\n');
    expect(result.calls).toHaveLength(1);
  });

  it.each(['ERROR: credentials not found', 'ERROR: connection reset', 'ERROR: denied'])('blocks registry uncertainty: %s', (registryError) => {
    const fixture = recoveryFixture(); fixture.registryError = registryError;
    const result = runRecoveryStep(recovery, fixture);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it.each(['signature', 'config', 'revision', 'architecture', 'extra-platform'])('blocks a substituted recovery %s before producing approval inputs', (change) => {
    const fixture = recoveryFixture();
    if (change === 'signature') fixture.invalidSignature = true;
    if (change === 'config') fixture.images.amd64.id = `sha256:${'9'.repeat(64)}`;
    if (change === 'revision') fixture.images.amd64.revision = '9'.repeat(40);
    if (change === 'architecture') fixture.images.amd64.architecture = 'arm64';
    if (change === 'extra-platform') fixture.index.manifests.push({ digest: `sha256:${'9'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } });
    const result = runRecoveryStep(recovery, fixture);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });

  it('reuses immutable subjects without rebuilding or pushing replacements', () => {
    const result = runRecoveryStep('Select verified platform subjects', recoveryFixture(), {
      RESUME: 'true', EXISTING_AMD64: `sha256:${'a'.repeat(64)}`, EXISTING_ARM64: `sha256:${'b'.repeat(64)}`, NEW_AMD64: '', NEW_ARM64: '',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(`amd64_digest=sha256:${'a'.repeat(64)}\narm64_digest=sha256:${'b'.repeat(64)}\n`);
    expect(result.calls).toHaveLength(0);
  });

  it.each(['manifest', 'artifact', 'appeared', 'disappeared'])('blocks recovery state changed between producer and writer: %s', (change) => {
    const fixture = recoveryFixture(), values = {};
    if (change === 'manifest') values.RECOVERY_MANIFEST_DIGEST = `sha256:${'9'.repeat(64)}`;
    if (change === 'artifact') fixture.images.amd64.id = `sha256:${'9'.repeat(64)}`;
    if (change === 'appeared') values.RECOVERY_MODE = 'false';
    if (change === 'disappeared') fixture.registryError = 'ERROR: ghcr.io/sky-zhang01/punchpilot:0.5.0: not found';
    const result = runRecoveryStep(inspect, fixture, values);
    expect(result.status).not.toBe(0);
    expect(result.output).toBe('');
  });
});

describe('release workflow security contracts', () => {
  const publicWorkflow = workflow('.github', 'docker-publish.yml');
  const ciWorkflow = workflow('.github', 'ci.yml');
  const internalWorkflow = sourceWorkflowsAvailable
    ? workflow('.gitea', 'internal-release-check.yml')
    : null;
  const sourceCiWorkflow = sourceWorkflowsAvailable
    ? workflow('.gitea', 'ci.yml')
    : null;
  const sourceHousekeeping = sourceWorkflowsAvailable
    ? workflow('.gitea', 'branch-housekeeping.yml')
    : null;
  const prePushHook = fs.readFileSync(path.join(root, '.githooks', 'pre-push'), 'utf8');
  const publicationPreflight = fs.readFileSync(
    path.join(root, 'scripts', 'ci', 'publication-preflight.mjs'),
    'utf8',
  );
  const boundedArm64Build = fs.readFileSync(
    path.join(root, 'scripts', 'ci', 'build-arm64-image.sh'),
    'utf8',
  );
  const publicExporter = fs.readFileSync(
    path.join(root, 'scripts', 'ci', 'export-public-tree.mjs'),
    'utf8',
  );

  it('keeps source workflow and export policy availability coherent', () => {
    expect(anySourceWorkflowAvailable).toBe(sourceWorkflowsAvailable);
    expect(sourceWorkflowsAvailable).toBe(sourcePolicyAvailable);
  });

  it('requires a secret-backed forbidden-host policy without embedding its values', () => {
    const workflows = [publicWorkflow, ciWorkflow];
    if (sourceWorkflowsAvailable) workflows.push(internalWorkflow, sourceCiWorkflow);
    for (const source of workflows) {
      expect(source).toContain(
        'PUBLIC_RELEASE_FORBIDDEN_HOSTS: ${{ secrets.PUBLIC_RELEASE_FORBIDDEN_HOSTS }}',
      );
    }
    expect(publicWorkflow).toContain('--require-forbidden-hosts');
    expect(ciWorkflow).toContain('--require-forbidden-hosts');
    expect(ciWorkflow).toContain('node scripts/ci/assert-forbidden-host-absence.mjs');
    expect(ciWorkflow).not.toContain('if [ "$GITHUB_EVENT_NAME" != "pull_request" ]; then');
    if (sourceWorkflowsAvailable) {
      expect(internalWorkflow).toContain('node scripts/ci/export-public-tree.mjs');
      expect(publicExporter).toContain("'--require-forbidden-hosts'");
      expect(publicExporter).toContain("'--fail-on-warn'");
      expect(sourceCiWorkflow).toContain('node scripts/ci/export-public-tree.mjs');
      expect(sourceCiWorkflow).toContain('node scripts/ci/assert-forbidden-host-absence.mjs');
    }
  });

  it('binds public history scans to public ancestry and source tags to the final tree', () => {
    expect(publicWorkflow).toContain(
      '"repos/${GITHUB_REPOSITORY}/releases?per_page=100"',
    );
    expect(publicWorkflow).toContain(
      'public_base=$(git rev-parse "refs/tags/${previous_release_tag}^{commit}")',
    );
    expect(publicWorkflow).toContain('select(.tag_name != $current)');
    expect(publicWorkflow).toContain('test "$public_base" != "$commit"');
    expect(publicWorkflow.indexOf('test "$public_base" != "$commit"'))
      .toBeLessThan(publicWorkflow.indexOf(
        'git merge-base --is-ancestor "$public_base" "$commit"',
      ));
    expect(publicWorkflow).not.toContain('previous_tag=$(git tag --merged "$commit"');
    expect(publicWorkflow).toContain('test "$commit" = "$public_main"');
    expect(publicWorkflow).toContain('test "$GITHUB_REF_NAME" = "$latest_tag"');
    expect(publicWorkflow).toContain(
      'actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${RELEASE_COMMIT}&per_page=100',
    );
    expect(publicWorkflow).not.toContain('&status=completed&');
    expect(publicWorkflow).toContain('sort_by([.run_number, .run_attempt, .id])');
    expect(publicWorkflow).toContain('| last');
    expect(publicWorkflow).toContain(
      'test "$(jq -r \'.status\' <<< "$latest_run")" = "completed"',
    );
    expect(publicWorkflow).toContain(
      'test "$(jq -r \'.conclusion\' <<< "$latest_run")" = "success"',
    );
    expect(publicWorkflow).not.toContain('any(.workflow_runs[]?');
    expect(publicWorkflow).toContain('--base "$PUBLIC_BASE_COMMIT"');
    if (sourceWorkflowsAvailable) {
      expect(internalWorkflow).toContain('if [ "$tag_commit" != "$source_main" ]; then');
      expect(internalWorkflow).toContain('--source "$release_tag"');
      expect(internalWorkflow).toContain('--source-tag "$release_tag"');
      expect(publicExporter).toMatch(/'--export-tree',\s+treeSha,/);
      expect(publicExporter).toContain("'--tag-envelope-file'");
      expect(internalWorkflow).not.toContain('--base "$PUBLIC_BASE_COMMIT"');
      expect(internalWorkflow).not.toContain('public_base');
      expect(internalWorkflow).not.toContain(
        'https://github.com/sky-zhang01/punchpilot.git',
      );
    }
    expect(ciWorkflow).toContain('PUSH_BASE_SHA: ${{ github.event.before }}');
    expect(ciWorkflow).toContain('history_base=$PR_BASE_SHA');
    expect(ciWorkflow).toContain('history_base=$PUSH_BASE_SHA');
    expect(ciWorkflow).toContain("history_base=$(git rev-parse 'HEAD^')");
    expect(ciWorkflow).toContain('git merge-base --is-ancestor "$history_base" HEAD');
    expect(ciWorkflow).toContain('--base "$history_base"');
    expect(ciWorkflow.match(/node scripts\/ci\/publication-preflight\.mjs/g))
      .toHaveLength(1);
    const publicTreeScan = ciWorkflow.indexOf('--ref HEAD');
    const publicEventBaseSelection = ciWorkflow.indexOf('case "$GITHUB_EVENT_NAME" in');
    expect(publicTreeScan).toBeGreaterThanOrEqual(0);
    expect(publicEventBaseSelection).toBeGreaterThan(publicTreeScan);
    expect(ciWorkflow).toContain("grep -Eq '^[0-9a-f]{40}$'");
    expect(ciWorkflow).toContain('git cat-file -e "${history_base}^{commit}"');
    if (sourceWorkflowsAvailable) {
      expect(sourceCiWorkflow).toContain(
        'PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}',
      );
      expect(sourceCiWorkflow).toContain(
        'PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
      );
      expect(sourceCiWorkflow).toContain('PUSH_BASE_SHA: ${{ github.event.before }}');
      expect(sourceCiWorkflow).toContain('scan_head=$PR_HEAD_SHA');
      expect(sourceCiWorkflow).toContain('history_base=$PR_BASE_SHA');
      expect(sourceCiWorkflow).toContain('history_base=$PUSH_BASE_SHA');
      expect(sourceCiWorkflow).toContain("history_base=$(git rev-parse 'HEAD^')");
      expect(sourceCiWorkflow).toContain(
        'git merge-base --is-ancestor "$history_base" "$scan_head"',
      );
      expect(sourceCiWorkflow).toContain('--source "$scan_head"');
      expect(sourceCiWorkflow).toContain('--policy .public-export/allowlist.json');
      expect(sourceCiWorkflow).toContain('test "$(git rev-parse HEAD)" = "$(git rev-parse "${scan_head}^{commit}")"');
      expect(sourceCiWorkflow).not.toContain('--commit-range');
      expect(sourceCiWorkflow).not.toContain('--no-scan');
      expect(sourceCiWorkflow).not.toContain('--head "$scan_head"');
      expect(sourceCiWorkflow).not.toContain('--base "$history_base"');
      expect(sourceCiWorkflow).not.toContain('node scripts/ci/publication-preflight.mjs');
      const sourceEventBaseSelection = sourceCiWorkflow.indexOf('case "$GITHUB_EVENT_NAME" in');
      const sourceTreeScan = sourceCiWorkflow.indexOf('--source "$scan_head"');
      expect(sourceEventBaseSelection).toBeGreaterThanOrEqual(0);
      expect(sourceTreeScan).toBeGreaterThan(sourceEventBaseSelection);
      expect(sourceCiWorkflow).toContain("grep -Eq '^[0-9a-f]{40}$'");
      expect(sourceCiWorkflow).toContain('git cat-file -e "${history_base}^{commit}"');
      expect(sourceCiWorkflow).toContain('Unsupported CI event for publication scan.');
      expect(sourceCiWorkflow).not.toContain('refs/remotes/public/main');
      expect(sourceCiWorkflow).not.toContain(
        'https://github.com/sky-zhang01/punchpilot.git',
      );
    }
    expect(jobSection(ciWorkflow, 'docker-build')).not.toContain(
      "if: github.event_name == 'workflow_dispatch' || github.event_name == 'pull_request'",
    );
  });

  it('keeps commit identity exemptions out of every publication caller', () => {
    if (sourceWorkflowsAvailable) {
      expect(sourceCiWorkflow).not.toContain('--exempt-source-commit-identity');
      expect(internalWorkflow).not.toContain('--exempt-source-commit-identity');
    }
    for (const source of [publicWorkflow, ciWorkflow, prePushHook, publicationPreflight]) {
      expect(source).not.toContain('--exempt-source-commit-identity');
    }
  });

  it('builds each release platform exactly once before publishing', () => {
    const buildJob = jobSection(publicWorkflow, 'build-and-scan');
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    expect(buildJob).toContain('bash scripts/ci/install-reviewed-node.sh');
    expect(publicWorkflow).toContain(`NODE_VERSION: ${reviewedNodeVersion}`);
    expect(buildJob.match(/docker\/build-push-action@/g)).toHaveLength(2);
    expect(buildJob.match(/if: steps.recovery.outputs.resume == 'false'/g)).toHaveLength(2);
    expect(stepOffset(buildJob, 'Recover signed immutable candidates before rebuilding'))
      .toBeLessThan(stepOffset(buildJob, 'Build amd64 release candidate once'));
    expect(publicWorkflow.match(/docker\/build-push-action@/g)).toHaveLength(2);
    expect(buildJob.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g))
      .toHaveLength(2);
    expect(publishJob.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g))
      .toHaveLength(2);
    expect(stepOffset(buildJob, 'Scan arm64 candidate and generate SBOM'))
      .toBeLessThan(stepOffset(buildJob, 'Package scanned release candidates'));
    expect(stepOffset(publishJob, 'Attest amd64 SBOM'))
      .toBeLessThan(stepOffset(publishJob, 'Publish immutable version manifest'));
    expect(stepOffset(publishJob, 'Publish immutable version manifest'))
      .toBeLessThan(stepOffset(publishJob, 'Attest multi-architecture build provenance'));
    expect(stepOffset(publishJob, 'Attest multi-architecture build provenance'))
      .toBeLessThan(stepOffset(publishJob, 'Verify current multi-architecture provenance'));
    expect(stepOffset(publishJob, 'Verify current multi-architecture provenance'))
      .toBeLessThan(stepOffset(
        publishJob,
        'Publish platform and mutable aliases from attested manifest',
      ));
    expect(publishJob.match(/actions\/checkout@/g)).toHaveLength(1);
    expect(publishJob).toContain('ref: ${{ needs.build-and-scan.outputs.release_commit }}');
    expect(publishJob).toContain('persist-credentials: false');
    expect(stepOffset(publishJob, 'Require current-attempt publication policy'))
      .toBeLessThan(stepOffset(publishJob, 'Checkout the exact public publication commit'));
    expect(stepOffset(publishJob, 'Verify public tool snapshot commit'))
      .toBeLessThan(stepOffset(publishJob, 'Install reviewed GitHub CLI'));
    expect(publishJob).toContain('bash scripts/ci/install-reviewed-gh.sh');
    expect(publishJob).toContain('version: ${{ env.BUILDX_VERSION }}');
    expect(publishJob).not.toContain('npm ci');
    expect(publishJob).not.toContain('npm run');
    expect(publishJob).not.toContain('refs/remotes/source/');
    expect(publishJob).not.toContain('docker/build-push-action@');
    expect(publishJob).not.toContain('actions/setup-node@');
    expect(publicWorkflow).not.toContain('docker/login-action@');
    expect(publicWorkflow).not.toContain('docker/metadata-action@');
    expect(publicWorkflow).not.toContain('Promotion-Check: passed');
  });

  it('uses the reviewed Node installer in every public workflow', () => {
    for (const name of ['ci.yml', 'docker-publish.yml', 'branch-housekeeping.yml']) {
      const source = workflow('.github', name);
      expect(source).not.toContain('actions/setup-node@');
      expect(source).toContain(`NODE_VERSION: ${reviewedNodeVersion}`);
      expect(source).toContain('bash scripts/ci/install-reviewed-node.sh');
    }
  });

  it('requires publication policy validation from the current workflow attempt', () => {
    const buildJob = jobSection(publicWorkflow, 'build-and-scan');
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    expect(buildJob).toContain(
      'publication_run_attempt: ${{ steps.publication-policy.outputs.run_attempt }}',
    );
    expect(stepOffset(buildJob, 'Publication preflight'))
      .toBeLessThan(stepOffset(buildJob, 'Bind publication policy to run attempt'));
    for (const writeJob of [publishJob]) {
      expect(writeJob).toMatch(
        /steps:\n\s+- name: Require current-attempt publication policy/,
      );
      expect(writeJob).toContain(
        'PUBLICATION_RUN_ATTEMPT: ${{ needs.build-and-scan.outputs.publication_run_attempt }}',
      );
      expect(writeJob).toContain(
        'test "$PUBLICATION_RUN_ATTEMPT" = "$GITHUB_RUN_ATTEMPT"',
      );
    }
    expect(stepOffset(publishJob, 'Require current-attempt publication policy'))
      .toBeLessThan(stepOffset(publishJob, 'Log in to GHCR'));
  });

  it('binds immutable image artifacts to the exact workflow attempt', () => {
    expect(publicWorkflow.match(/punchpilot-release-amd64-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g))
      .toHaveLength(2);
    expect(publicWorkflow.match(/punchpilot-release-arm64-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g))
      .toHaveLength(3);
    expect(publicWorkflow).not.toMatch(
      /punchpilot-release-(?:amd64|arm64)-\$\{\{ github\.run_id \}\}(?!-\$\{\{ github\.run_attempt \}\})/,
    );
    expect(publicWorkflow.match(/retention-days: 7/g)).toHaveLength(2);
    expect(publicWorkflow).not.toContain('overwrite: true');
  });

  it('refreshes the runtime OS layer without discarding dependency build caches', () => {
    const ciDockerBuild = jobSection(ciWorkflow, 'docker-build');
    const ciArm64Build = jobSection(ciWorkflow, 'docker-build-arm64');
    expect(ciDockerBuild.match(/no-cache-filters: runtime/g)).toHaveLength(1);
    expect(ciArm64Build.match(/no-cache-filters: runtime/g)).toHaveLength(1);
    expect(publicWorkflow.match(/no-cache-filters: runtime/g)).toHaveLength(2);
    expect(ciDockerBuild.match(/pull: true/g)).toHaveLength(1);
    expect(ciArm64Build.match(/pull: true/g)).toHaveLength(1);
    expect(publicWorkflow.match(/pull: true/g)).toHaveLength(2);
    expect(boundedArm64Build).toContain('--no-cache-filter runtime');
    expect(boundedArm64Build).toContain('--pull');
    expect(ciDockerBuild).toContain('cache-from: type=gha,scope=ci-amd64');
    expect(ciArm64Build).toContain('cache-from: type=gha,scope=ci-arm64');
    if (sourceWorkflowsAvailable) {
      const sourceDockerBuild = jobSection(sourceCiWorkflow, 'docker-build');
      expect(sourceDockerBuild.match(/no-cache-filters: runtime/g)).toHaveLength(1);
      expect(internalWorkflow.match(/no-cache-filters: runtime/g)).toHaveLength(1);
      expect(internalWorkflow.match(/pull: true/g)).toHaveLength(1);
      expect(sourceDockerBuild).toContain('cache-from: type=gha,scope=ci-amd64');
    }
  });

  it('bounds emulated arm64 source builds and uses native public arm64 runners', () => {
    const publicArm64Job = jobSection(ciWorkflow, 'docker-build-arm64');
    expect(boundedArm64Build).toContain('readonly default_timeout_seconds=1500');
    expect(boundedArm64Build).toContain('"--kill-after=${kill_after_seconds}s"');
    expect(publicArm64Job).toContain('runs-on: ubuntu-26.04-arm');
    expect(publicArm64Job).not.toContain('Set up QEMU');
    expect(publicArm64Job).toContain('--require-native-browser');
    if (sourceWorkflowsAvailable) {
      const sourceAmd64Job = jobSection(sourceCiWorkflow, 'docker-build');
      const sourceArm64Job = jobSection(sourceCiWorkflow, 'docker-build-arm64');
      expect(sourceCiWorkflow).not.toContain('timeout-minutes:');
      expect(internalWorkflow).not.toContain('timeout-minutes:');
      expect(sourceAmd64Job).not.toContain('Set up QEMU');
      expect(sourceAmd64Job).not.toContain('linux/arm64');
      expect(sourceArm64Job).toContain("if: github.event_name == 'workflow_dispatch'");
      expect(sourceArm64Job).toContain('needs: docker-build');
      expect(sourceArm64Job).toContain('Set up QEMU');
      expect(sourceArm64Job).toContain('bash scripts/ci/build-arm64-image.sh ci');
      expect(internalWorkflow).toContain(
        'bash scripts/ci/build-arm64-image.sh release "$RELEASE_COMMIT"',
      );
      expect(internalWorkflow).toContain(
        'cache-from: type=gha,scope=release-check-amd64',
      );
    }
  });

  it('limits write permissions and pins the attestation action', () => {
    const buildJob = jobSection(publicWorkflow, 'build-and-scan');
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    const publishPermissions = [
      'contents: read',
      'actions: read',
      'packages: write',
      'id-token: write',
      'attestations: write',
      'artifact-metadata: write',
    ].join('\\n\\s+');
    expect(buildJob).toMatch(/permissions:\n\s+contents: read/);
    expect(buildJob).not.toMatch(/permissions:[\s\S]*?\bwrite\b/);
    expect(publishJob).toMatch(
      new RegExp(`permissions:\\n\\s+${publishPermissions}`),
    );
    expect(publicWorkflow).not.toMatch(/^  release:\s*$/m);
    expect(publicWorkflow).not.toContain('contents: write');
    expect(publicWorkflow).not.toContain('gh release');
    expect(publicWorkflow).not.toContain('git push');
    expect(
      publicWorkflow.match(
        /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/g,
      ),
    ).toHaveLength(3);
    expect(
      publicWorkflow.match(/github\.actor == 'punchpilot-release-bot\[bot\]'/g),
    ).toHaveLength(3);
    expect(
      publicWorkflow.match(
        /github\.triggering_actor == github\.repository_owner/g,
      ),
    ).toHaveLength(3);
    expect(publicWorkflow.match(/vars\.PUNCHPILOT_PUBLICATION_ENABLED == 'true'/g))
      .toHaveLength(3);
    expect(publicWorkflow).toContain('group: punchpilot-public-release');
    expect(publishJob).toContain('environment: public-release');
  });

  it('binds both tag-triggered workflows to the event commit', () => {
    expect(publicWorkflow).toContain('test "$(git cat-file -t "$tag_ref")" = "tag"');
    expect(publicWorkflow).toContain('tag_object=$(git rev-parse --verify "$tag_ref")');
    expect(publicWorkflow).toContain(
      'release_tag_object: ${{ steps.candidate.outputs.tag_object }}',
    );
    expect(publicWorkflow).toContain(
      'test "$commit" = "$(git rev-parse "${GITHUB_SHA}^{commit}")"',
    );
    expect(publicWorkflow).toContain(
      'test "$current_tag_object" = "$EXPECTED_TAG_OBJECT"',
    );
    expect(publicWorkflow).toContain(
      'test "$(jq -er \'.object.sha\' <<< "$tag_object")" = "$EXPECTED_COMMIT"',
    );
    if (sourceWorkflowsAvailable) {
      expect(internalWorkflow).toContain('tag_object=$(git rev-parse --verify "$tag_ref")');
      expect(internalWorkflow).toContain('printf \'tag_object=%s\\n\' "$tag_object"');
      expect(internalWorkflow).toContain(
        'event_commit=$(git rev-parse "${GITHUB_SHA}^{commit}")',
      );
      expect(internalWorkflow).toContain('if [ "$tag_commit" != "$event_commit" ]; then');
      expect(stepOffset(internalWorkflow, 'Select release candidate'))
        .toBeLessThan(stepOffset(internalWorkflow, 'Verify release candidate binding'));
      expect(stepOffset(internalWorkflow, 'Verify release candidate binding'))
        .toBeLessThan(stepOffset(internalWorkflow, 'Publication preflight'));
    }
    expect(publicWorkflow).not.toContain('publication-approved-');
  });

  it('revalidates remote publication authority before every public write boundary', () => {
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    const registryCheck = publishJob.slice(
      stepOffset(publishJob, 'Inspect resumable release state before registry write'),
      stepOffset(publishJob, 'Push the scanned platform images'),
    );
    const aliasCheck = publishJob.slice(
      stepOffset(publishJob, 'Revalidate publication authority before mutable aliases'),
      stepOffset(publishJob, 'Publish platform and mutable aliases from attested manifest'),
    );
    expect(aliasCheck).toContain('node scripts/ci/isolated-publisher.mjs public-authority');
    expect(registryCheck).toContain('gh api "repos/${GITHUB_REPOSITORY}/commits/main"');
    expect(registryCheck).toContain('git/ref/tags/${GITHUB_REF_NAME}');
    expect(registryCheck).toContain('test "$current_tag_object" = "$EXPECTED_TAG_OBJECT"');
    expect(registryCheck).toContain(
      'test "$(jq -er \'.object.sha\' <<< "$tag_object")" = "$EXPECTED_COMMIT"',
    );
    expect(registryCheck).toContain('actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${EXPECTED_COMMIT}');
    expect(registryCheck).toContain('test "$(jq -r \'.conclusion\' <<< "$latest_run")" = "success"');
    expect(stepOffset(publishJob, 'Inspect resumable release state before registry write'))
      .toBeLessThan(stepOffset(publishJob, 'Log in to GHCR'));
    expect(publishJob).toContain(
      'PUBLICATION_ADMISSION_SHA256: ${{ vars.PUNCHPILOT_PUBLICATION_ADMISSION_SHA256 }}',
    );
    expect(publishJob).toContain(
      'PUBLICATION_ADMISSION_JSON: ${{ secrets.PUNCHPILOT_PUBLICATION_ADMISSION }}',
    );
    expect(stepOffset(publishJob, 'Load independently approved publication receipt'))
      .toBeLessThan(stepOffset(publishJob, 'Revalidate publication authority before registry credentials'));
    expect(stepOffset(publishJob, 'Revalidate publication authority before registry credentials'))
      .toBeLessThan(stepOffset(publishJob, 'Log in to GHCR'));
    const writeLines = publishJob.split('\n');
    const registryWrites = writeLines.flatMap((line, index) => (
      /^\s+docker (?:push |buildx imagetools create\b)/.test(line) ? [index] : []
    ));
    expect(registryWrites).toHaveLength(6);
    for (const index of registryWrites) {
      expect(writeLines[index - 1].trim())
        .toBe('node scripts/ci/isolated-publisher.mjs public-authority');
    }
    for (const [gate, writer] of [
      ['Revalidate publication authority before amd64 attestation', 'Attest amd64 SBOM'],
      ['Revalidate publication authority before arm64 attestation', 'Attest arm64 SBOM'],
      ['Revalidate publication authority before manifest attestation', 'Attest multi-architecture build provenance'],
    ]) {
      const gateBlock = publishJob.slice(stepOffset(publishJob, gate), stepOffset(publishJob, writer));
      expect(gateBlock).toContain('run: node scripts/ci/isolated-publisher.mjs public-authority');
    }
  });

  it('resumes partial releases from verified immutable digests', () => {
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    expect(stepOffset(publishJob, 'Inspect resumable release state before registry write'))
      .toBeLessThan(stepOffset(publishJob, 'Push the scanned platform images'));
    expect(stepOffset(publishJob, 'Push the scanned platform images'))
      .toBeLessThan(stepOffset(publishJob, 'Select verified platform subjects'));
    expect(publishJob).toContain("staging=\"${version}-staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}\"");
    expect(publishJob).toContain("if [ \"$RESUME\" = \"true\" ]; then");
    expect(publishJob).toContain('org.opencontainers.image.revision');
    const inspectStep = publishJob.slice(
      stepOffset(publishJob, 'Inspect resumable release state before registry write'),
      stepOffset(publishJob, 'Push the scanned platform images'),
    );
    expect(inspectStep).toContain('and (.manifests | length == 2)');
    expect(inspectStep).not.toContain('gh attestation verify');
    expect(publishJob).toContain('gh attestation verify');
    expect(publishJob).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/docker-publish.yml"');
    expect(publishJob).toContain('--source-digest "$EXPECTED_COMMIT"');
    expect(publishJob).toContain('--source-ref "$GITHUB_REF"');
    expect(publishJob).toContain('--deny-self-hosted-runners');
    const pushStep = publishJob.slice(
      stepOffset(publishJob, 'Push the scanned platform images'),
      stepOffset(publishJob, 'Select verified platform subjects'),
    );
    expect(pushStep).toContain("if: steps.registry.outputs.resume == 'false'");
    const subjectStep = publishJob.slice(
      stepOffset(publishJob, 'Select verified platform subjects'),
      stepOffset(publishJob, 'Attest amd64 SBOM'),
    );
    expect(subjectStep).toContain('amd64_digest=$EXISTING_AMD64');
    expect(subjectStep).toContain('arm64_digest=$EXISTING_ARM64');
    expect(subjectStep).toContain('amd64_digest=$NEW_AMD64');
    expect(subjectStep).toContain('arm64_digest=$NEW_ARM64');
    const amd64SbomStep = publishJob.slice(
      stepOffset(publishJob, 'Attest amd64 SBOM'),
      stepOffset(publishJob, 'Attest arm64 SBOM'),
    );
    const arm64SbomStep = publishJob.slice(
      stepOffset(publishJob, 'Attest arm64 SBOM'),
      stepOffset(publishJob, 'Publish immutable version manifest'),
    );
    expect(amd64SbomStep).not.toContain("if: steps.registry.outputs.resume != 'true'");
    expect(arm64SbomStep).not.toContain("if: steps.registry.outputs.resume != 'true'");
    const provenanceStep = publishJob.slice(
      stepOffset(publishJob, 'Attest multi-architecture build provenance'),
      stepOffset(publishJob, 'Revalidate publication authority before mutable aliases'),
    );
    expect(provenanceStep).not.toContain("if: steps.registry.outputs.resume != 'true'");
    expect(provenanceStep).toContain('/tmp/current-release-provenance.json');
    expect(publishJob).toContain('grep -Fqx "ERROR: ${version_ref}: not found"');
    expect(publishJob).toContain('docker push "$amd64_tag" 2>&1 | tee');
    expect(publishJob).toContain('docker push "$arm64_tag" 2>&1 | tee');
    expect(publishJob).toContain('extract_push_digest()');
    expect(publishJob).not.toContain('imagetools inspect --raw "$amd64_tag"');
    expect(publishJob).not.toContain('imagetools inspect --raw "$arm64_tag"');
    expect(publishJob).toContain('--metadata-file /tmp/release-manifest-metadata.json');
    expect(publishJob.match(/--prefer-index=false/g)).toHaveLength(2);
    expect(publicWorkflow).not.toContain('- name: Create or verify GitHub Release');
    expect(publicWorkflow).not.toContain('gh release edit');
  });

  it('separates source and public event admission without pull_request_target', () => {
    if (sourceWorkflowsAvailable) {
      expect(sourceCiWorkflow).toContain('pull_request:');
      expect(sourceCiWorkflow).not.toContain('pull_request_target:');
      expect(sourceCiWorkflow).toContain('branches: [main]');
      expect(sourceCiWorkflow).toContain('workflow_dispatch:');
      const sourceSecurity = jobSection(sourceCiWorkflow, 'security-scan');
      expect(sourceSecurity).toContain('- name: Admit trusted source event');
      expect(sourceSecurity).toContain('PR_HEAD_REPOSITORY: ${{ github.event.pull_request.head.repo.full_name }}');
      expect(sourceSecurity).toContain('test "$PR_HEAD_REPOSITORY" = "$SOURCE_REPOSITORY"');
      expect(stepOffset(sourceSecurity, 'Admit trusted source event'))
        .toBeLessThan(stepOffset(sourceSecurity, 'Public content baseline scan'));
      expect(sourceHousekeeping).toContain('workflow_dispatch:');
    }
    expect(ciWorkflow).toContain('pull_request:');
    expect(ciWorkflow).not.toContain('pull_request_target:');
    expect(fs.existsSync(path.join(
      root,
      '.github',
      'workflows',
      'internal-release-check.yml',
    ))).toBe(false);
    expect(fs.existsSync(path.join(
      root,
      '.gitea',
      'workflows',
      'docker-publish.yml',
    ))).toBe(false);
  });

  sourceIt('keeps the public export drift comment same-repository, least-privilege, and non-blocking', () => {
    const driftJob = jobSection(sourceCiWorkflow, 'public-export-drift');
    expect(driftJob).toContain(
      "if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(driftJob).toContain('group: public-export-drift-${{ github.event.pull_request.number }}');
    expect(driftJob).toContain('cancel-in-progress: true');
    const permissionBlock = driftJob.match(
      /^    permissions:\n((?:      [a-z-]+: (?:read|write|none)\n)+)/m,
    );
    expect(permissionBlock).not.toBeNull();
    expect(permissionBlock[1].trim().split('\n').map((line) => line.trim())).toEqual([
      'contents: read',
      'pull-requests: write',
    ]);
    expect(driftJob.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(driftJob.match(/fetch-depth: 0/g)).toHaveLength(2);
    expect(driftJob).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(driftJob).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(driftJob).toContain('path: .ci-pr-base\n          fetch-depth: 0');
    expect(driftJob).toContain('git fetch --no-tags .ci-pr-base "$PR_BASE_SHA"');
    expect(driftJob).toContain("test \"$(git rev-parse 'FETCH_HEAD^{commit}')\" = \"$PR_BASE_SHA\"");
    expect(stepOffset(driftJob, 'Import and verify exact base commit object'))
      .toBeLessThan(stepOffset(driftJob, 'Compute public export drift report'));
    const computeStep = driftJob.slice(
      stepOffset(driftJob, 'Compute public export drift report'),
      stepOffset(driftJob, 'Publish public export drift comment'),
    );
    const publishStep = driftJob.slice(stepOffset(driftJob, 'Publish public export drift comment'));
    const summaryStep = driftJob.slice(stepOffset(driftJob, 'Summarize public export drift delivery'));
    expect(computeStep).toContain('id: compute-drift');
    expect(computeStep).toContain('if: always()');
    expect(computeStep).toContain('continue-on-error: true');
    expect(computeStep).toContain('--expected-node-version "v${NODE_VERSION}"');
    expect(publishStep).toContain('if: always()');
    expect(publishStep).toContain('id: publish-drift');
    expect(publishStep).toContain('continue-on-error: true');
    expect(publishStep).toContain('--expected-node-version "v${NODE_VERSION}"');
    expect(publishStep).toContain('GITEA_TOKEN: ${{ secrets.GITEA_TOKEN }}');
    expect(publishStep).toContain('GITEA_API_URL: ${{ github.api_url }}');
    expect(driftJob.match(/secrets\.GITEA_TOKEN/g)).toHaveLength(1);
    expect(summaryStep).toContain('if: always()');
    expect(summaryStep).toContain('continue-on-error: true');
    expect(summaryStep).toContain('COMPUTE_OUTCOME: ${{ steps.compute-drift.outcome }}');
    expect(summaryStep).toContain('PUBLISH_OUTCOME: ${{ steps.publish-drift.outcome }}');
    expect(summaryStep).toContain('Public export drift delivery was non-blocking but unsuccessful');
    expect(summaryStep).toContain('>> "$GITHUB_STEP_SUMMARY"');
  });

  sourceIt('uses strict shell mode in every internal release script block', () => {
    const scriptBlocks = internalWorkflow.match(/run: \|\n([\s\S]*?)(?=\n\s{6}- |\n\s{2}[a-zA-Z0-9_-]+:|$)/g) || [];
    expect(scriptBlocks).toHaveLength(9);
    for (const block of scriptBlocks) {
      expect(block).toMatch(/run: \|\n\s+set -euo pipefail/);
    }
  });

  it('requires native arm64 Chromium verification before publishing', () => {
    const armJob = jobSection(publicWorkflow, 'verify-arm64-runtime');
    const publishJob = jobSection(publicWorkflow, 'publish-image');
    expect(armJob).toContain('runs-on: ubuntu-26.04-arm');
    expect(armJob).toContain('--require-native-browser');
    expect(armJob).toContain('punchpilot-release-arm64-${{ github.run_id }}');
    expect(publishJob).toContain('needs: [build-and-scan, verify-arm64-runtime]');
  });

  it('verifies npm registry signatures for server and client dependency trees', () => {
    expect(ciWorkflow.match(/npm audit signatures/g)).toHaveLength(2);
    expect(stepOffset(ciWorkflow, 'Audit server dependencies'))
      .toBeLessThan(stepOffset(ciWorkflow, 'Verify server registry signatures'));
    expect(stepOffset(ciWorkflow, 'Audit client dependencies'))
      .toBeLessThan(stepOffset(ciWorkflow, 'Verify client registry signatures'));
    if (sourceWorkflowsAvailable) {
      expect(internalWorkflow.match(/npm audit signatures/g)).toHaveLength(2);
      expect(stepOffset(internalWorkflow, 'Audit server dependencies'))
        .toBeLessThan(stepOffset(internalWorkflow, 'Verify server registry signatures'));
      expect(stepOffset(internalWorkflow, 'Audit client dependencies'))
        .toBeLessThan(stepOffset(internalWorkflow, 'Verify client registry signatures'));
    }
  });

  it('installs Trivy without a forge token or mutable setup action', () => {
    const installer = fs.readFileSync(
      path.join(root, 'scripts', 'ci', 'install-trivy.sh'),
      'utf8',
    );
    const workflows = [publicWorkflow, ciWorkflow];
    if (sourceWorkflowsAvailable) workflows.push(internalWorkflow, sourceCiWorkflow);
    for (const source of workflows) {
      expect(source).not.toContain('aquasecurity/setup-trivy@');
      expect(source).not.toContain("token: ''");
    }
    expect(ciWorkflow.match(/bash scripts\/ci\/install-trivy\.sh/g)).toHaveLength(3);
    expect(publicWorkflow.match(/bash scripts\/ci\/install-trivy\.sh/g)).toHaveLength(2);
    if (sourceWorkflowsAvailable) {
      expect(sourceCiWorkflow.match(/bash scripts\/ci\/install-trivy\.sh/g)).toHaveLength(2);
      expect(internalWorkflow.match(/bash scripts\/ci\/install-trivy\.sh/g)).toHaveLength(1);
    }
    expect(installer).toContain("readonly version='0.75.0'");
    expect(installer).toContain(
      'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f',
    );
    expect(installer).toContain(
      'a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3',
    );
    expect(installer).toContain("--proto '=https'");
    expect(installer).toContain('sha256sum --check --status');
  });

  it('selects the reviewed npm CLI after every independent client Node setup', () => {
    const clientBuild = jobSection(ciWorkflow, 'client-build');
    const e2eSmoke = jobSection(ciWorkflow, 'e2e-smoke');
    expect(stepOffset(clientBuild, 'Use reviewed npm CLI'))
      .toBeLessThan(stepOffset(clientBuild, 'Install client dependencies'));
    expect(stepOffset(e2eSmoke, 'Use reviewed npm CLI'))
      .toBeLessThan(stepOffset(e2eSmoke, 'Install client dependencies'));
    if (sourceWorkflowsAvailable) {
      expect(stepOffset(internalWorkflow, 'Use reviewed npm CLI'))
        .toBeLessThan(stepOffset(internalWorkflow, 'Install client dependencies'));
    }
  });
});
