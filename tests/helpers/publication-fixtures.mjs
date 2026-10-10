import { admissionSubject, BOT_NAME, digest, jsonBytes } from '../../scripts/ci/publication-contract.mjs';

// Disposable fixture receipts. Production receipts come from independently
// reviewed owner/platform/runner evidence and are pinned outside the artifact.
export function reviewedAdmission(tuple, { changedWorkflows = false, entrySha256 = '6'.repeat(64), now = 1700000000 } = {}) {
  const subjectSha256 = admissionSubject(tuple);
  const permissions = changedWorkflows ? { contents: 'write', workflows: 'write' } : { contents: 'write' };
  const appId = 123456;
  const rulesets = ['branch', 'tag'].map((target, index) => ({
    id: index + 1, target, enforcement: 'active',
    conditions: { ref_name: { include: [target === 'branch' ? 'refs/heads/main' : `refs/tags/${tuple.version}`], exclude: [] } },
    bypass_actors: [{ actor_type: 'Integration', actor_id: appId, bypass_mode: 'always' }],
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }],
  }));
  const issuedAt = Math.max(0, now - 100), expiresAt = now + 3600;
  const admission = {
    ...tuple, schema: 'punchpilot-publication-admission',
    ownerApproval: 'fixture-owner-review', platformEvidence: 'fixture-platform-review', runnerEvidence: 'fixture-runner-review',
    actor: BOT_NAME, repository: 'sky-zhang01/punchpilot', scopeProfile: changedWorkflows ? 'workflow-changing' : 'contents',
    permissions, issuedAt, expiresAt, revoked: false,
    receipts: {
      owner: { actor: 'sky-zhang01', decision: 'approved', approvalId: 'fixture-owner-review', subjectSha256, issuedAt, expiresAt },
      platform: { receiptId: 'fixture-platform-review', repository: 'sky-zhang01/punchpilot', appId, installationId: 789012,
        account: { login: 'sky-zhang01', type: 'User' }, repositoryIdentity: { full_name: 'sky-zhang01/punchpilot', id: 345678 }, observedAt: issuedAt, expiresAt, rulesets,
        environment: { name: 'public-release', can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true },
          protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { login: 'sky-zhang01', id: 456789 } }] }] },
        branchPolicies: { branch_policies: [{ id: 1, type: 'tag', name: tuple.version }] } },
      runner: { receiptId: 'fixture-runner-review', subjectSha256, observedAt: issuedAt, expiresAt,
        reviewedEntrySha256: entrySha256, sourceCheckoutMounted: false, sourceCredentialsMounted: false,
        internalNetworkAllowed: false, environmentNames: [], gitRemotes: [], objectTypesBeforeImport: [] },
    },
  };
  return { admission, publication: { ...tuple, admissionSha256: digest(jsonBytes(admission)), reviewedEntrySha256: entrySha256 } };
}
