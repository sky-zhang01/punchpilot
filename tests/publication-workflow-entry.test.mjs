import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const workflowFile = new URL('../.gitea/workflows/public-release.yml', import.meta.url);
const sourceWorkflowAvailable = fs.existsSync(workflowFile);
const sourcePolicyAvailable = fs.existsSync(new URL('../.public-export/allowlist.json', import.meta.url));
const sourceIt = sourceWorkflowAvailable ? it : it.skip;
const workflow = sourceWorkflowAvailable ? fs.readFileSync(workflowFile, 'utf8') : null;
const publisher = new URL('../scripts/ci/isolated-publisher.mjs', import.meta.url).pathname;
describe('disabled public preparation and isolated runtime caller', () => {
  it.each([
    ['export-public-tree', 'exportPublicTree'],
    ['isolated-publisher', 'preparePublication'],
  ])('imports %s from standard input without invoking its CLI', (name, symbol) => {
    const url = new URL(`../scripts/ci/${name}.mjs`, import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `import * as module from ${JSON.stringify(url)}; console.log(typeof module.${symbol});`,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('function\n');
    expect(result.stderr).toBe('');
  });
  it.each(['GITEA_TEST_IDENTITY', 'PUNCHPILOT_SOURCE_TEST', 'GIT_OBJECT_DIRECTORY'])('rejects inherited %s before opening consumer storage', (name) => {
    const url = new URL('../scripts/ci/isolated-publisher.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `import { preparePublication } from ${JSON.stringify(url)};
        try { preparePublication({}); process.exitCode = 1; }
        catch (error) { console.log(error.message); }`,
      env: { ...process.env, [name]: 'fixture-internal-value' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('consumer cannot inherit internal credentials or object storage\n');
    expect(result.stderr).toBe('');
  });
  it('keeps internal caller and source-only export policy availability coherent', () => {
    expect(sourceWorkflowAvailable).toBe(sourcePolicyAvailable);
  });
  sourceIt('keeps preparation opt-in and actual public writing hard disabled', () => {
    expect(workflow).toContain("vars.PUNCHPILOT_SOURCE_PUBLICATION_PREPARATION_ENABLED == 'true'");
    expect(workflow).toMatch(/publish:\n(?:[^\n]*\n)*?    if: false\n/);
    expect(workflow).toContain('runs-on: punchpilot-release');
    const consumer = workflow.slice(workflow.indexOf('  publish:'));
    expect(consumer).not.toMatch(/uses:\s*actions\/(?:checkout|download-artifact)|GITEA_|ACTIONS_RUNTIME_TOKEN|SOURCE_PUBLICATION_POLICY_FILE/);
    expect(consumer).toContain('env -i HOME="$HOME" PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C');
    for (const name of ['APP_ID', 'INSTALLATION_ID', 'PRIVATE_KEY']) expect(consumer).toContain(`RELEASE_BOT_${name}="${'${'}RELEASE_BOT_${name}:-}"`);
  });
  sourceIt('uploads the exact five E artifact files without reviewed consumer code or keys', () => {
    const artifactPaths = workflow.slice(workflow.indexOf('          path: |'), workflow.indexOf('  publish:'));
    expect(artifactPaths.trim().split('\n').slice(1).map((line) => line.trim().split('/').at(-1))).toEqual(['allowlist.json', 'export.pack', 'manifest.json', 'source-ci-proof.json', 'source-tag.raw']);
    expect(workflow).toContain('overwrite: false');
  });
  it.each(['--refspec', '--token', '--source-gate', '--force'])('rejects injected publisher option %s', (name) => {
    const result = spawnSync(process.execPath, [publisher, 'publish', name, 'untrusted'], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('invalid publisher arguments');
  });
});
