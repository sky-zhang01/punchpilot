import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalObjects, assertAdmission, BOT_NAME, BOT_EMAIL, withPublicGpgContext } from '../scripts/ci/publication-contract.mjs';
import { reviewedAdmission } from './helpers/publication-fixtures.mjs';
const sourcePublicKeyAsset = new URL('../.public-export/public-signing-keys.asc', import.meta.url);
const sourcePublicKeyIt = fs.existsSync(sourcePublicKeyAsset) ? it : it.skip;

const tuple = {
  sourceCommit: '1'.repeat(40), exportedTree: '2'.repeat(40),
  publicBase: '3'.repeat(40), version: 'v1.2.3', sourceEpoch: 1700000000,
  artifactSha256: '4'.repeat(64), policyHash: '5'.repeat(64),
};
function oid(type, body) {
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}
function admission() {
  return reviewedAdmission(tuple).admission;
}
describe('shared publication contract', () => {
  sourcePublicKeyIt('keeps a short public-only key context alive only throughout the operation', () => {
    const certificate = fs.readFileSync(sourcePublicKeyAsset);
    let usedHome;
    expect(withPublicGpgContext(certificate, (home) => {
      usedHome = home;
      expect(fs.statSync(home).mode & 0o077).toBe(0);
      const records = execFileSync('gpg', ['--no-options', '--homedir', home, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(records).toContain('fpr:');
      expect(execFileSync('gpg', ['--no-options', '--homedir', home, '--batch', '--with-colons', '--list-secret-keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('');
      return 'checked';
    })).toBe('checked');
    expect(fs.existsSync(usedHome)).toBe(false);
    expect(() => withPublicGpgContext(certificate, (home) => { usedHome = home; throw new Error('fixture failure'); })).toThrow('fixture failure');
    expect(fs.existsSync(usedHome)).toBe(false);
  });
  it('rejects private or malformed certificate input before entering the operation', () => {
    for (const bytes of [Buffer.from('-----BEGIN PGP PRIVATE KEY BLOCK-----\nfixture\n-----END PGP PRIVATE KEY BLOCK-----\n'), Buffer.from('fixture')]) {
      let entered = false;
      expect(() => withPublicGpgContext(bytes, () => { entered = true; })).toThrow(/public/);
      expect(entered).toBe(false);
    }
  });
  it('KC4 freezes exact unsigned bytes and identical object IDs across caller clocks', () => {
    const first = canonicalObjects(tuple);
    const second = canonicalObjects({ ...tuple, now: 9999999999 });
    expect(first.commit.equals(second.commit)).toBe(true);
    expect(first.tag.equals(second.tag)).toBe(true);
    expect(first.commitId).toBe(oid('commit', first.commit));
    expect(first.tagId).toBe(oid('tag', first.tag));
    expect(first.commit.toString()).toBe(
      `tree ${tuple.exportedTree}\nparent ${tuple.publicBase}\nauthor ${BOT_NAME} <${BOT_EMAIL}> 1700000000 +0000\ncommitter ${BOT_NAME} <${BOT_EMAIL}> 1700000000 +0000\n\nchore(release): v1.2.3\n\nsource: gitea/${tuple.sourceCommit}\nsource-tree: ${tuple.exportedTree}\n`,
    );
    expect(first.tag.toString()).toBe(
      `object ${first.commitId}\ntype commit\ntag v1.2.3\ntagger ${BOT_NAME} <${BOT_EMAIL}> 1700000000 +0000\n\nv1.2.3\n\nsource: gitea/${tuple.sourceCommit}\nsource-tree: ${tuple.exportedTree}\n`,
    );
  });
  it.each(['sourceCommit', 'exportedTree', 'publicBase', 'version', 'sourceEpoch'])(
    'rejects malformed canonical %s before creating objects', (field) => {
      expect(() => canonicalObjects({ ...tuple, [field]: 'invalid' })).toThrow();
    },
  );
  it('requires the complete externally bound admission before any public write', () => {
    expect(assertAdmission(admission(), reviewedAdmission(tuple).publication, 1700000000, false)).toEqual({ contents: 'write' });
    expect(() => assertAdmission(null, tuple, 1700000000, false)).toThrow(/admission/);
  });
  it.each(['sourceCommit', 'exportedTree', 'publicBase', 'version', 'artifactSha256', 'policyHash'])(
    'rejects a replayed admission with a different %s', (field) => {
      expect(() => assertAdmission({ ...admission(), [field]: 'other' }, tuple, 1700000000, false)).toThrow(/binding/);
    },
  );
  it.each([
    { revoked: true }, { expiresAt: 1700000000 }, { issuedAt: 1700000001 },
    { ownerApproval: '' }, { platformEvidence: '' }, { runnerEvidence: '' },
    { actor: 'other[bot]' }, { repository: 'other/project' },
    { permissions: { contents: 'write', actions: 'write' } },
    { scopeProfile: 'workflow-changing', permissions: { contents: 'write', workflows: 'write' } },
  ])('rejects invalid or excessive admission %#', (override) => {
    expect(() => assertAdmission({ ...admission(), ...override }, tuple, 1700000000, false)).toThrow();
  });
  it('requires reviewed workflows permission only for actual workflow subtree changes', () => {
    expect(() => assertAdmission(admission(), tuple, 1700000000, true)).toThrow(/scope/);
    const approved = reviewedAdmission(tuple, { changedWorkflows: true });
    expect(assertAdmission(approved.admission, approved.publication, 1700000000, true)).toEqual(approved.admission.permissions);
  });
  it('rejects receipt replay, an unprotected environment, and internal runner inputs even when the receipt is freshly pinned', () => {
    for (const alter of [
      (admission) => { admission.receipts.owner.subjectSha256 = '0'.repeat(64); },
      (admission) => { admission.receipts.platform.rulesets[0].bypass_actors.push({ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }); },
      (admission) => { admission.receipts.platform.environment.protection_rules = []; },
      (admission) => { admission.receipts.runner.sourceCredentialsMounted = true; },
    ]) {
      const { admission, publication } = reviewedAdmission(tuple); alter(admission);
      publication.admissionSha256 = createHash('sha256').update(JSON.stringify(admission) + '\n').digest('hex');
      expect(() => assertAdmission(admission, publication, 1700000000, false)).toThrow(/receipt|platform|environment/);
    }
  });
  it.each(['owner', 'platform', 'runner'])('rejects missing or wrongly typed %s receipt times', (name) => {
    const start = name === 'owner' ? 'issuedAt' : 'observedAt';
    for (const field of [start, 'expiresAt']) for (const value of [undefined, null, '1700000010', 1.5]) {
      const { admission, publication } = reviewedAdmission(tuple);
      admission.receipts[name][field] = value;
      publication.admissionSha256 = createHash('sha256').update(JSON.stringify(admission) + '\n').digest('hex');
      expect(() => assertAdmission(admission, publication, 1700000000, false)).toThrow(/receipt/);
    }
  });
  it.each([true, undefined, null, 'false'])('rejects observable or unknown administrator bypass %s before minting', (value) => {
    const { admission, publication } = reviewedAdmission(tuple);
    admission.receipts.platform.environment.can_admins_bypass = value;
    publication.admissionSha256 = createHash('sha256').update(JSON.stringify(admission) + '\n').digest('hex');
    expect(() => assertAdmission(admission, publication, 1700000000, false)).toThrow(/environment/);
  });
});
