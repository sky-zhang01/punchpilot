import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalObjects, digest, jsonBytes } from '../scripts/ci/publication-contract.mjs';
import {
  collectObservations, evaluateObservations, githubRead, readPages,
  sourceProjection, validateBaseline, verifyEvidence, writeEvidence,
} from '../scripts/ci/public-governance-check.mjs';

const repository = '/repos/sky-zhang01/punchpilot';
const directories = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'punchpilot-governance-')); directories.push(directory); return directory; };
const publication = { sourceCommit: '1'.repeat(40), exportedTree: '2'.repeat(40), publicBase: '3'.repeat(40), version: 'v0.5.1', sourceEpoch: 1700000000, policyHash: '4'.repeat(64) };
const objects = canonicalObjects(publication);
const rules = ['branch', 'tag'].map((target, index) => ({ id: index + 1, target, enforcement: 'active', conditions: { ref_name: { include: [target === 'branch' ? 'refs/heads/main' : 'refs/tags/v*'], exclude: [] } }, bypass_actors: [{ actor_type: 'Integration', actor_id: 7, bypass_mode: 'always' }], rules: ['creation', 'update', 'deletion', 'non_fast_forward'].map((type) => ({ type })) }));
const configuration = {
  repository: { id: 9, full_name: 'sky-zhang01/punchpilot', default_branch: 'main', visibility: 'public', archived: false, disabled: false, security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
  rulesets: rules,
  environment: { name: 'public-release', can_admins_bypass: false, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 10, login: 'sky-zhang01' } }] }] },
  branchPolicies: [{ id: 11, type: 'tag', name: 'v*' }],
  actions: { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
  selectedActions: { github_owned_allowed: false, verified_allowed: false, patterns_allowed: ['actions/checkout@' + 'a'.repeat(40)] },
  workflowPermissions: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
  deployKeys: [], collaborators: [{ id: 10, login: 'sky-zhang01', permissions: { admin: true, push: true } }],
  app: { id: 7, slug: 'punchpilot-release-bot', owner: { login: 'sky-zhang01', type: 'User' }, permissions: { contents: 'write', metadata: 'read', workflows: 'write' } },
  installations: [{ id: 8, app_id: 7, app_slug: 'punchpilot-release-bot', account: { login: 'sky-zhang01', type: 'User' }, suspended_at: null, repository_selection: 'selected', permissions: { contents: 'write', metadata: 'read', workflows: 'write' } }],
};
const baseline = { schema: 'punchpilot-public-governance-baseline', repository: 'sky-zhang01/punchpilot', publication, appId: 7, installationId: 8, configuration };
function api(overrides = {}) {
  const routes = {
    [repository]: configuration.repository,
    [repository + '/git/ref/heads/main']: { ref: 'refs/heads/main', object: { type: 'commit', sha: objects.commitId } },
    [repository + '/git/ref/tags/v0.5.1']: { ref: 'refs/tags/v0.5.1', object: { type: 'tag', sha: objects.tagId } },
    [repository + '/git/commits/' + objects.commitId]: { sha: objects.commitId, tree: { sha: publication.exportedTree }, parents: [{ sha: publication.publicBase }] },
    [repository + '/rulesets?includes_parents=true&per_page=100&page=1']: rules.map(({ id }) => ({ id })),
    ...Object.fromEntries(rules.map((rule) => [repository + '/rulesets/' + rule.id + '?includes_parents=true', rule])),
    [repository + '/environments/public-release']: configuration.environment,
    [repository + '/environments/public-release/deployment-branch-policies?per_page=100&page=1']: { total_count: 1, branch_policies: configuration.branchPolicies },
    [repository + '/actions/permissions']: configuration.actions,
    [repository + '/actions/permissions/selected-actions']: configuration.selectedActions,
    [repository + '/actions/permissions/workflow']: configuration.workflowPermissions,
    [repository + '/keys?per_page=100&page=1']: [],
    [repository + '/collaborators?affiliation=all&per_page=100&page=1']: configuration.collaborators,
    '/apps/punchpilot-release-bot': configuration.app,
    '/user/installations?per_page=100&page=1': { total_count: 1, installations: configuration.installations },
  };
  return async ({ endpoint }) => {
    if (Object.hasOwn(overrides, endpoint)) return overrides[endpoint];
    if (!Object.hasOwn(routes, endpoint)) throw new Error('unexpected route ' + endpoint);
    return { status: 200, body: structuredClone(routes[endpoint]), headers: {} };
  };
}
const source = { sourceCommit: publication.sourceCommit, exportedTree: publication.exportedTree, policyHash: publication.policyHash, privacy: 'PASS', codeowners: true, actionPins: ['actions/checkout@' + 'a'.repeat(40)] };
const run = { codeCommit: 'b'.repeat(40), runId: 'fixture', runAttempt: 1 };
async function result(overrides) { const observations = await collectObservations({ api: api(overrides), version: publication.version, run }); return { observations, report: evaluateObservations({ observations, baseline, source }) }; }

describe('public governance read-only boundary', () => {
  it('binds the entire content tree and frozen publication, not path membership', async () => {
    expect((await result()).report.status).toBe('PASS');
    const changed = await result({ [repository + '/git/commits/' + objects.commitId]: { status: 200, body: { sha: objects.commitId, tree: { sha: 'c'.repeat(40) }, parents: [{ sha: publication.publicBase }] } } });
    expect(changed.report.checks.publication).toBe('FAIL');
  });
  it.each(['main', 'tag'])('rejects a moved %s ref', async (ref) => {
    const endpoint = repository + (ref === 'main' ? '/git/ref/heads/main' : '/git/ref/tags/v0.5.1');
    expect((await result({ [endpoint]: { status: 200, body: { object: { type: ref === 'main' ? 'commit' : 'tag', sha: 'c'.repeat(40) } } } })).report.checks.publication).toBe('FAIL');
  });
  it('keeps App/installation visibility failures UNKNOWN rather than absence or approval', async () => {
    const checked = await result({ '/apps/punchpilot-release-bot': { status: 404, body: { message: 'Not Found' } }, '/user/installations?per_page=100&page=1': { status: 403, body: { message: 'Forbidden' } } });
    expect(checked.report.status).toBe('UNKNOWN');
    expect(checked.report.checks.configuration).toBe('UNKNOWN');
  });
  it('never turns an observation without a reviewed baseline into admission', async () => {
    const { observations } = await result();
    const report = evaluateObservations({ observations });
    expect(report.status).toBe('UNKNOWN');
    expect(report.authorizesPublication).toBe(false);
  });
  it('rejects weak Actions settings even if present in an approved comparison baseline', () => {
    const weak = structuredClone(baseline); weak.configuration.actions.allowed_actions = 'all';
    expect(() => validateBaseline(weak)).toThrow(/Actions/);
  });
  it('rejects administrative bypass and a second release actor', () => {
    const weak = structuredClone(baseline); weak.configuration.rulesets[0].bypass_actors.push({ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' });
    expect(() => validateBaseline(weak)).toThrow(/sole release App/);
    weak.configuration.rulesets[0] = structuredClone(rules[0]); weak.configuration.environment.can_admins_bypass = true;
    expect(() => validateBaseline(weak)).toThrow(/environment/);
  });
  it('rejects write deploy keys and broader third party Actions', () => {
    const weak = structuredClone(baseline); weak.configuration.deployKeys = [{ id: 7, read_only: false }];
    expect(() => validateBaseline(weak)).toThrow(/deploy/);
    weak.configuration.deployKeys = []; weak.configuration.selectedActions.patterns_allowed = ['actions/*'];
    expect(() => validateBaseline(weak)).toThrow(/SHA/);
  });
  it('rejects self-review and extra branch policies', () => {
    const weak = structuredClone(baseline); weak.configuration.environment.protection_rules[0].prevent_self_review = false;
    expect(() => validateBaseline(weak)).toThrow(/environment/);
    weak.configuration.environment = structuredClone(configuration.environment); weak.configuration.branchPolicies.push({ id: 22, type: 'branch', name: 'main' });
    expect(() => validateBaseline(weak)).toThrow(/tag policy/);
  });
  it('fails configuration drift and source/export drift separately', async () => {
    const { observations } = await result();
    expect(evaluateObservations({ observations, baseline, source: { ...source, exportedTree: 'c'.repeat(40) } }).checks.sourceExport).toBe('FAIL');
    const drift = await result({ [repository + '/actions/permissions']: { status: 200, body: { ...configuration.actions, sha_pinning_required: false } } });
    expect(drift.report.checks.configuration).toBe('FAIL');
  });
  it('uses the same security projection for ruleset order and volatile owner response fields', async () => {
    const unchanged = rules.map((record) => ({ ...structuredClone(record), rules: [...record.rules].reverse(), updated_at: '2026-10-08T00:00:00Z', current_user_can_bypass: 'always' }));
    const checked = await result(Object.fromEntries(unchanged.map((record) => [repository + '/rulesets/' + record.id + '?includes_parents=true', { status: 200, body: record }])));
    expect(checked.report.checks.rulesets).toBe('PASS');
    expect(checked.report.status).toBe('PASS');
  });
  it('does not project hidden bypass actors into an empty safe set', async () => {
    const hidden = structuredClone(rules[0]); delete hidden.bypass_actors;
    const checked = await result({ [repository + '/rulesets/1?includes_parents=true']: { status: 200, body: hidden } });
    expect(checked.report.checks.rulesets).not.toBe('PASS');
    expect(checked.report.status).not.toBe('PASS');
  });
  it('consumes private evidence again and rejects forged summary or changed baseline', async () => {
    const { observations, report } = await result(); const directory = path.join(temporary(), 'evidence');
    writeEvidence({ directory, observations, report, source, baselineSha256: digest(jsonBytes(baseline)) });
    expect(verifyEvidence({ directory, baseline, baselineSha256: digest(jsonBytes(baseline)), source }).status).toBe('PASS');
    fs.writeFileSync(path.join(directory, 'summary.json'), jsonBytes({ status: 'PASS' }), { mode: 0o600 });
    expect(() => verifyEvidence({ directory, baseline, baselineSha256: digest(jsonBytes(baseline)), source })).toThrow(/readback/);
  });
  it('rejects wrong digest, unsafe paths and permissive evidence permissions', async () => {
    const { observations, report } = await result(); const directory = path.join(temporary(), 'evidence');
    writeEvidence({ directory, observations, report, source, baselineSha256: digest(jsonBytes(baseline)) });
    expect(() => verifyEvidence({ directory, baseline, baselineSha256: 'f'.repeat(64), source })).toThrow(/baseline/);
    fs.chmodSync(path.join(directory, 'observations.json'), 0o644);
    expect(() => verifyEvidence({ directory, baseline, baselineSha256: digest(jsonBytes(baseline)), source })).toThrow(/private/);
  });
  it('exports only safe summary digests, never private response fields or tokens', async () => {
    const { observations, report } = await result(); const directory = path.join(temporary(), 'evidence');
    writeEvidence({ directory, observations, report, source, baselineSha256: digest(jsonBytes(baseline)) });
    const summary = fs.readFileSync(path.join(directory, 'summary.json'), 'utf8');
    expect(summary).not.toContain('collaborators'); expect(summary).not.toContain('reviewers'); expect(summary).not.toContain('sky-zhang01');
    expect(JSON.parse(summary).authorizesPublication).toBe(false);
  });
});

describe('complete API observation', () => {
  const nextRelations = ['rel=next', 'type="application/json"; rel="next"', 'rel="next alternate"'];
  it.each(nextRelations)('follows the complete Link relation %s and refuses consumer truncation', async (relation) => {
    const records = [];
    const link = '<https://api.github.com' + repository + '/keys?per_page=100&page=2>; ' + relation;
    const response = await readPages({ endpoint: repository + '/keys', records, api: async ({ endpoint }) => endpoint.endsWith('page=1')
      ? { status: 200, body: [{ id: 1 }], headers: { link } } : { status: 200, body: [{ id: 2 }], headers: {} } });
    expect(response).toEqual([{ id: 1 }, { id: 2 }]); expect(records).toHaveLength(2);
    const approved = structuredClone(baseline); approved.configuration.deployKeys = [{ id: 1, key: 'fixture-key', read_only: true }];
    const observations = await collectObservations({ api: api({
      [repository + '/keys?per_page=100&page=1']: { status: 200, body: approved.configuration.deployKeys, headers: { link } },
      [repository + '/keys?per_page=100&page=2']: { status: 200, body: [{ id: 2, key: 'unexpected-write-key', read_only: false }], headers: {} },
    }), version: publication.version, run });
    const report = evaluateObservations({ observations, baseline: approved, source });
    expect(report.checks.access).toBe('FAIL');
    const directory = path.join(temporary(), 'evidence'), baselineSha256 = digest(jsonBytes(approved));
    writeEvidence({ directory, observations, report, source, baselineSha256 });
    expect(verifyEvidence({ directory, baseline: approved, baselineSha256, source }).checks.access).toBe('FAIL');
    const truncated = structuredClone(observations);
    truncated.records = truncated.records.filter((record) => record.endpoint !== repository + '/keys?per_page=100&page=2');
    expect(evaluateObservations({ observations: truncated, baseline: approved, source }).checks.access).toBe('UNKNOWN');
  });
  it('consumes comma-separated next/last links and terminal previous links', async () => {
    const destination = 'https://api.github.com' + repository + '/keys?per_page=100&page=';
    const records = [];
    const response = await readPages({ endpoint: repository + '/keys', records, api: async ({ endpoint }) => endpoint.endsWith('page=1')
      ? { status: 200, body: [{ id: 1 }], headers: { link: '<' + destination + '2>; rel="last", <' + destination + '2>; type="application/json"; rel="NEXT"' } }
      : { status: 200, body: [{ id: 2 }], headers: { link: '<' + destination + '1>; rel="prev"' } } });
    expect(response).toEqual([{ id: 1 }, { id: 2 }]); expect(records).toHaveLength(2);
  });
  it.each(['rel="next"; rel="last"', 'type="application/json"', 'rel="next" trailing', 'rel="next",', 'rel="next"; title="bad\\"quote"'])('rejects ambiguous or unconsumed Link parameters %s', async (parameters) => {
    await expect(readPages({ endpoint: repository + '/keys', records: [], api: async () => ({ status: 200, body: [], headers: {
      link: '<https://api.github.com' + repository + '/keys?per_page=100&page=2>; ' + parameters,
    } }) })).rejects.toThrow(/pagination/);
  });
  it('follows all Link pages even when the first page is short', async () => {
    const records = [];
    const response = await readPages({ endpoint: repository + '/keys', records, api: async ({ endpoint }) => endpoint.endsWith('page=1') ? { status: 200, body: [{ id: 1 }], headers: { link: '<https://api.github.com' + repository + '/keys?per_page=100&page=2>; rel="next"' } } : { status: 200, body: [{ id: 2 }], headers: {} } });
    expect(response).toEqual([{ id: 1 }, { id: 2 }]); expect(records).toHaveLength(2);
  });
  it('rejects redirected, foreign, cycling and non-sequential pagination links', async () => {
    for (const link of ['https://example.com/a?page=2', 'https://api.github.com' + repository + '/keys?per_page=100&page=1', 'https://api.github.com' + repository + '/keys?per_page=100&page=3']) {
      await expect(readPages({ endpoint: repository + '/keys', records: [], api: async () => ({ status: 200, body: [], headers: { link: '<' + link + '>; rel="next"' } }) })).rejects.toThrow(/pagination/);
    }
  });
  it('rejects omitted object pagination and duplicate records', async () => {
    await expect(readPages({ endpoint: repository + '/keys', key: 'keys', records: [], api: async () => ({ status: 200, body: { total_count: 2, keys: [{ id: 1 }] }, headers: {} }) })).rejects.toThrow(/incomplete/);
    await expect(readPages({ endpoint: repository + '/keys', records: [], api: async () => ({ status: 200, body: [{ id: 1 }, { id: 1 }], headers: {} }) })).rejects.toThrow(/duplicate/);
  });
  it('rejects HTTP, malformed JSON, missing body and full pages without a next link', async () => {
    for (const response of [{ status: 403, body: {} }, { status: 200, body: {} }, { status: 200, body: null }, { status: 200, body: Array.from({ length: 100 }, (_, id) => ({ id: id + 1 })), headers: {} }]) {
      await expect(readPages({ endpoint: repository + '/keys', records: [], api: async () => response })).rejects.toThrow();
    }
  });
  it('enforces GET-only and fixed-origin endpoints before opening any network connection', async () => {
    for (const options of [{ endpoint: repository + '/keys', method: 'POST' }, { endpoint: 'https://example.com' }, { endpoint: '/repos/other/project' }, { endpoint: repository + '/../secret' }]) {
      await expect(githubRead(options)).rejects.toThrow(/read-only|endpoint/);
    }
  });
});


describe('actual source and public entry consumers', () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.join(projectRoot, 'scripts/ci/public-governance-check.mjs');
  const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const actionRevisions = {
    checkout: { commit_sha: '3d3c42e5aac5ba805825da76410c181273ba90b1' },
    uploadArtifact: { commit_sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a' },
    attest: { commit_sha: '1e69f48acb82d1966a394da916b4c1698aa569d6' },
  };
  const checkoutPin = 'actions/checkout@' + actionRevisions.checkout.commit_sha;
  function sourceRepository(pin = checkoutPin, { workflow = 'steps:\n  - uses: ' + pin + '\n', codeowners = '* @sky-zhang01\n' } = {}) {
    const root = temporary();
    git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true }); fs.mkdirSync(path.join(root, '.public-export'));
    fs.writeFileSync(path.join(root, 'README.md'), '# Public content\n');
    fs.writeFileSync(path.join(root, '.github/CODEOWNERS'), codeowners);
    fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), workflow);
    fs.writeFileSync(path.join(root, '.public-export/allowlist.json'), JSON.stringify({ $schema: 'public-export-allowlist/v1', version: 1, include: ['README.md', '.github/'], exclude: ['.public-export/'] }));
    git(root, ['add', '-A']); git(root, ['commit', '-qm', 'clean source']);
    return { root, commit: git(root, ['rev-parse', 'HEAD']) };
  }
  it('recomputes the frozen S export and ignores newer unreleased source content', () => {
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const { root, commit } = sourceRepository();
    const frozen = { publication: { ...publication, sourceCommit: commit } };
    const before = sourceProjection(root, frozen);
    expect(before.privacy).toBe('PASS'); expect(before.codeowners).toBe(true);
    expect(before.actionPins).toEqual([checkoutPin]);
    fs.writeFileSync(path.join(root, 'README.md'), '# Unreleased content\n'); git(root, ['add', '-A']); git(root, ['commit', '-qm', 'unreleased']);
    expect(sourceProjection(root, frozen)).toEqual(before);
  });
  it('rejects missing privacy policy and actual mutable workflow action references', () => {
    const { root, commit } = sourceRepository();
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', '');
    expect(() => sourceProjection(root, { publication: { ...publication, sourceCommit: commit } })).toThrow(/verified-clean/);
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const mutable = sourceRepository('actions/checkout@main');
    expect(() => sourceProjection(mutable.root, { publication: { ...publication, sourceCommit: mutable.commit } })).toThrow(/full SHA/);
  });
  it.each([
    '  - { uses: actions/upload-artifact@main }',
    '  - "uses": actions/upload-artifact@main',
    '  - "u\\u0073es": actions/upload-artifact@main',
    '  - &unchecked uses: actions/upload-artifact@main',
    '  - *unchecked',
    '  - !!map { uses: actions/upload-artifact@main }',
    '  - ["uses": actions/upload-artifact@main]',
    '  - ? uses\n    : actions/upload-artifact@main',
    '  - uses: >\n      actions/upload-artifact@main',
  ])('rejects actual exported workflow syntax outside the reviewed block form: %s', (unchecked) => {
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const fixture = sourceRepository(undefined, { workflow: 'steps:\n  - uses: ' + checkoutPin + '\n' + unchecked + '\n' });
    expect(() => sourceProjection(fixture.root, { publication: { ...publication, sourceCommit: fixture.commit } })).toThrow(/workflow|full SHA/);
  });
  it.each(['.github/workflows/*', '.github/workflows/* @someone-else', '* @someone-else', '* @sky-zhang01'])('rejects actual later CODEOWNERS rule %s', (override) => {
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const fixture = sourceRepository(undefined, { codeowners: '# Reviewed owner\n* @sky-zhang01\n' + override + '\n' });
    expect(() => sourceProjection(fixture.root, { publication: { ...publication, sourceCommit: fixture.commit } })).toThrow(/CODEOWNERS/);
  });
  it('accepts reviewed block uses and treats script scalar contents as data', () => {
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const fixture = sourceRepository(undefined, { workflow: 'steps:\n  - name: Script\n    run: |\n      echo \'{ uses: actions/upload-artifact@main }\'\n      echo "uses: unknown"\n    env:\n      LABEL: "literal { braces }"\n      VALUE: ${{ github.event_name == \'push\' && \'yes\' || \'no\' }}\n  - uses: ' + checkoutPin + ' # reviewed\n', codeowners: '# Reviewed owner\n* @sky-zhang01\n\n' });
    expect(sourceProjection(fixture.root, { publication: { ...publication, sourceCommit: fixture.commit } }).actionPins).toEqual([checkoutPin]);
  });
  it('accepts every current public workflow through the actual exporter shape gate', () => {
    vi.stubEnv('PUBLIC_RELEASE_FORBIDDEN_HOSTS', 'private.example.invalid');
    const fixture = sourceRepository();
    fs.cpSync(path.join(projectRoot, '.github/workflows'), path.join(fixture.root, '.github/workflows'), { recursive: true });
    git(fixture.root, ['add', '-A']); git(fixture.root, ['commit', '-qm', 'current reviewed workflow shapes']);
    const projection = sourceProjection(fixture.root, { publication: { ...publication, sourceCommit: git(fixture.root, ['rev-parse', 'HEAD']) } });
    expect(projection.actionPins).toContain(checkoutPin);
    expect(projection.actionPins).toContain('actions/upload-artifact@' + actionRevisions.uploadArtifact.commit_sha);
    expect(projection.actionPins).toContain('actions/attest@' + actionRevisions.attest.commit_sha);
  });
  it('rejects malformed CLI, missing baseline and false code ref before any request', () => {
    const evidence = path.join(temporary(), 'evidence');
    for (const args of [[], ['check', '--evidence', evidence], ['observe', '--evidence', evidence, '--version', 'v0.5.1', '--run-id', 'fixture', '--run-attempt', '1', '--code-commit', 'f'.repeat(40)], ['observe', '--evidence', evidence, '--unknown', 'value']]) {
      const response = spawnSync(process.execPath, [entry, ...args], { cwd: projectRoot, encoding: 'utf8' });
      expect(response.status).toBe(1); expect(response.stdout).toBe(''); expect(response.stderr).not.toContain('token'); expect(fs.existsSync(evidence)).toBe(false);
    }
  });
  it('keeps administrator bypass UNKNOWN when the real REST schema omits that field', async () => {
    const expected = structuredClone(baseline); delete expected.configuration.environment.can_admins_bypass;
    const { observations } = await result({ [repository + '/environments/public-release']: { status: 200, body: expected.configuration.environment } });
    const report = evaluateObservations({ observations, baseline: expected, source });
    expect(report.checks.environment).toBe('PASS'); expect(report.checks.administratorBypass).toBe('UNKNOWN');
    expect(report.checks.configuration).toBe('UNKNOWN'); expect(report.status).toBe('UNKNOWN');
  });
  it('does not hide known configuration drift behind unknown installation metadata', async () => {
    const checked = await result({ [repository + '/actions/permissions']: { status: 200, body: { enabled: true, allowed_actions: 'all', sha_pinning_required: false } }, '/user/installations?per_page=100&page=1': { status: 403, body: {} } });
    expect(checked.report.checks.actions).toBe('FAIL'); expect(checked.report.checks.installation).toBe('UNKNOWN'); expect(checked.report.status).toBe('FAIL');
  });
  it('verifies endpoint/run identities and rejects relabelled or reordered evidence', async () => {
    const { observations } = await result();
    const relabelled = structuredClone(observations); relabelled.records.find((record) => record.group === 'main').endpoint = repository + '/actions/permissions';
    expect(() => evaluateObservations({ observations: relabelled, baseline, source })).toThrow(/endpoint/);
    const leaked = structuredClone(observations); leaked.run.privateValue = 'must never reach artifact';
    expect(() => evaluateObservations({ observations: leaked, baseline, source })).toThrow(/identity/);
    const reordered = structuredClone(observations); reordered.records.at(-1).observedAt = '2000-01-01T00:00:00Z';
    expect(() => evaluateObservations({ observations: reordered, baseline, source })).toThrow(/chronology/);
  });
  it('uses actual GET request options and redacts the transient clone credential', async () => {
    let options;
    const request = (value, callback) => {
      options = value; const outgoing = new EventEmitter(); outgoing.setTimeout = () => {}; outgoing.destroy = (error) => outgoing.emit('error', error);
      outgoing.end = () => queueMicrotask(() => { const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.headers = {}; callback(incoming); incoming.emit('data', Buffer.from(JSON.stringify({ id: 9, temp_clone_token: 'synthetic-clone-token' }))); incoming.emit('end'); });
      return outgoing;
    };
    const response = await githubRead({ endpoint: repository, token: 'synthetic-observer', request });
    expect(options.method).toBe('GET'); expect(options.hostname).toBe('api.github.com'); expect(options.headers.Authorization).toBe('Bearer synthetic-observer');
    expect(response.body).toEqual({ id: 9 }); expect(response.responseSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects a real response stream with malformed or oversized JSON', async () => {
    for (const bytes of [Buffer.from('{bad JSON'), Buffer.alloc(8 * 1024 * 1024 + 1, 32)]) {
      const request = (_options, callback) => {
        const outgoing = new EventEmitter(); outgoing.setTimeout = () => {}; outgoing.destroy = (error) => outgoing.emit('error', error);
        outgoing.end = () => queueMicrotask(() => { const incoming = new EventEmitter(); incoming.statusCode = 200; incoming.headers = {}; callback(incoming); incoming.emit('data', bytes); incoming.emit('end'); });
        return outgoing;
      };
      await expect(githubRead({ endpoint: repository, request })).rejects.toThrow(/malformed|transport/);
    }
  });
});
