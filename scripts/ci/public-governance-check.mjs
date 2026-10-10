#!/usr/bin/env node
// Observations are evidence for review, never publication admission or approval.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_NAME, LIMIT, OID, SHA256, VERSION, canonicalObjects, digest, durableFile,
  canonicalJson, gitBytes, gitText, jsonBytes, platformProtection, privateFile, readPrivateJson,
} from './publication-contract.mjs';
import { exportPublicTree, parseAllowlist } from './export-public-tree.mjs';

const REPOSITORY = 'sky-zhang01/punchpilot';
const REPO = `/repos/${REPOSITORY}`;
const APP = BOT_NAME.replace('[bot]', '');
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 1000;
const stable = canonicalJson;
const sorted = (items) => [...items].sort((a, b) => stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0);
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(object || {}, key)).map((key) => [key, object[key]]));
function endpointAllowed(endpoint) {
  return typeof endpoint === 'string' && !/[\s\\#\0-\x1f\x7f]/.test(endpoint) && !endpoint.includes('..') &&
    (endpoint === REPO || endpoint.startsWith(`${REPO}/`) || endpoint === `/apps/${APP}` || endpoint.startsWith('/user/installations?'));
}
export async function githubRead({ endpoint, token, method = 'GET', request = https.request }) {
  if (method !== 'GET') throw new Error('governance API is read-only');
  if (!endpointAllowed(endpoint)) throw new Error('governance API endpoint is outside the fixed repository');
  if (token && /[\r\n]/.test(token)) throw new Error('invalid observer token');
  return new Promise((resolve, reject) => {
    const outgoing = request({ protocol: 'https:', hostname: 'api.github.com', port: 443, method: 'GET', path: endpoint,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'punchpilot-public-governance', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > MAX_BYTES) outgoing.destroy(new Error('governance response exceeds limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks);
          const body = JSON.parse(bytes.toString('utf8'));
          // Repository API can contain a transient clone credential. Never persist it.
          if (body && typeof body === 'object') delete body.temp_clone_token;
          resolve({ status: response.statusCode, body, headers: { link: response.headers.link || '' }, responseSha256: digest(bytes) });
        } catch { reject(new Error('governance API response is malformed JSON')); }
      });
    });
    outgoing.setTimeout(30000, () => outgoing.destroy(new Error('governance API timeout')));
    outgoing.on('error', () => reject(new Error('governance API transport failed')));
    outgoing.end();
  });
}
function nextPage(link, endpoint, page) {
  if (!link) return null;
  // Consume every Link value. Unsupported syntax cannot establish completion.
  if (typeof link !== 'string' || /[\r\n]/.test(link)) throw new Error('invalid API pagination header');
  const target = /\s*<([^<>\s]+)>\s*/y;
  const parameter = /;\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"\\\r\n]*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))\s*/y;
  const next = []; let offset = 0;
  do {
    target.lastIndex = offset; const entry = target.exec(link);
    if (!entry) throw new Error('unrecognized API pagination target');
    offset = target.lastIndex; const parameters = new Map();
    while (link[offset] === ';') {
      parameter.lastIndex = offset; const field = parameter.exec(link);
      if (!field || parameters.has(field[1].toLowerCase())) throw new Error('ambiguous API pagination parameter');
      parameters.set(field[1].toLowerCase(), field[2] ?? field[3]); offset = parameter.lastIndex;
    }
    const relation = parameters.get('rel');
    if (!relation || parameters.has('anchor') || !/^[A-Za-z][A-Za-z0-9.-]*(?:[ \t]+[A-Za-z][A-Za-z0-9.-]*)*$/.test(relation)) throw new Error('unrecognized API pagination relation');
    if (relation.toLowerCase().split(/[ \t]+/).includes('next')) next.push(entry[1]);
    if (offset === link.length) break;
    if (link[offset] !== ',') throw new Error('unconsumed API pagination header');
    offset += 1;
    if (!link.slice(offset).trim()) throw new Error('incomplete API pagination header');
  } while (offset < link.length);
  if (next.length > 1) throw new Error('ambiguous API pagination');
  if (!next.length) return null;
  const url = new URL(next[0]);
  const expected = new URL(`https://api.github.com${endpoint}`);
  const filters = (value) => sorted([...value.searchParams].filter(([key]) => !['page', 'per_page'].includes(key)));
  if (url.origin !== expected.origin || url.username || url.password || url.hash || url.pathname !== expected.pathname ||
      url.searchParams.getAll('page').length !== 1 || url.searchParams.get('page') !== String(page + 1) ||
      url.searchParams.getAll('per_page').length !== 1 || url.searchParams.get('per_page') !== '100' ||
      stable(filters(url)) !== stable(filters(expected))) throw new Error('API pagination escaped or skipped a page');
  return `${url.pathname}${url.search}`;
}
function pageItems(record, key) {
  if (record.status !== 200) throw new Error('API authority is unknown');
  const items = key ? record.body?.[key] : record.body;
  if (!Array.isArray(items) || items.length > 100 || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('invalid API pagination body');
  if (key && (!Number.isSafeInteger(record.body.total_count) || record.body.total_count < 0)) throw new Error('API pagination count is missing');
  return items;
}
function completePages(records, key) {
  const items = []; let total = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index], batch = pageItems(record, key);
    if (key) { if (total !== null && record.body.total_count !== total) throw new Error('API pagination count changed'); total = record.body.total_count; }
    const next = nextPage(record.headers?.link, record.endpoint, index + 1);
    if (next && records[index + 1]?.endpoint !== next) throw new Error('incomplete API pagination');
    if (!next && index !== records.length - 1) throw new Error('unexpected API pagination records');
    if (!next && batch.length === 100 && total === null) throw new Error('full API page has no completion evidence');
    items.push(...batch);
  }
  if (total !== null && total !== items.length) throw new Error('incomplete API pagination count');
  if (new Set(items.map((item) => item.id)).size !== items.length || items.some((item) => !Number.isSafeInteger(item.id) || item.id < 1)) throw new Error('duplicate or invalid API record identity');
  return items;
}
async function readOne({ api, endpoint, records, group }) {
  const observedAt = new Date().toISOString();
  try {
    const response = await api({ method: 'GET', endpoint });
    const record = { group, endpoint, observedAt, status: response.status, body: response.body,
      headers: { link: response.headers?.link || '' }, responseSha256: response.responseSha256 || digest(jsonBytes(response.body ?? null)) };
    records.push(record);
    if (record.status !== 200) throw new Error('API authority is unknown');
    return record;
  } catch (error) {
    if (records.at(-1)?.endpoint !== endpoint) records.push({ group, endpoint, observedAt, status: null, body: null, headers: {}, transport: 'UNKNOWN' });
    throw error;
  }
}
export async function readPages({ api, endpoint, records, key = null, group = 'pages' }) {
  const local = [];
  const url = new URL(`https://api.github.com${endpoint}`); url.searchParams.set('per_page', '100'); url.searchParams.set('page', '1');
  let current = `${url.pathname}${url.search}`;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const record = await readOne({ api, endpoint: current, records, group }); local.push(record);
    pageItems(record, key);
    const next = nextPage(record.headers.link, current, page);
    if (!next) return completePages(local, key);
    current = next;
  }
  throw new Error('API pagination exceeded bounded page count');
}
export async function collectObservations({ api = githubRead, version, run }) {
  if (!VERSION.test(version) || !OID.test(run?.codeCommit) || typeof run.runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(run.runId) ||
      !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1) throw new Error('governance observation run/version binding is invalid');
  const records = [], errors = [];
  const capture = async (group, operation) => { try { return await operation(); } catch { errors.push(group); return null; } };
  const one = (group, endpoint) => capture(group, () => readOne({ api, endpoint, records, group }));
  const pages = (group, endpoint, key) => capture(group, () => readPages({ api, endpoint, records, group, key }));
  await one('repository', REPO);
  const main = await one('main', `${REPO}/git/ref/heads/main`);
  if (OID.test(main?.body?.object?.sha)) await one('commit', `${REPO}/git/commits/${main.body.object.sha}`);
  await one('tag', `${REPO}/git/ref/tags/${version}`);
  const rulesets = await pages('rulesetList', `${REPO}/rulesets?includes_parents=true`);
  if (rulesets) for (const rule of rulesets) await one(`ruleset:${rule.id}`, `${REPO}/rulesets/${rule.id}?includes_parents=true`);
  await one('environment', `${REPO}/environments/public-release`);
  await pages('branchPolicies', `${REPO}/environments/public-release/deployment-branch-policies`, 'branch_policies');
  const actions = await one('actions', `${REPO}/actions/permissions`);
  if (actions?.body?.allowed_actions === 'selected') await one('selectedActions', `${REPO}/actions/permissions/selected-actions`);
  await one('workflowPermissions', `${REPO}/actions/permissions/workflow`);
  await pages('deployKeys', `${REPO}/keys`);
  await pages('collaborators', `${REPO}/collaborators?affiliation=all`);
  await one('app', `/apps/${APP}`);
  await pages('installations', '/user/installations', 'installations');
  await one('mainFinal', `${REPO}/git/ref/heads/main`);
  await one('tagFinal', `${REPO}/git/ref/tags/${version}`);
  return { schema: 'punchpilot-public-governance-observations',
    run: { codeCommit: run.codeCommit, runId: run.runId, runAttempt: run.runAttempt,
      collectorSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))) }, version, records, errors };
}
function groupRecords(observations, name) { return observations.records.filter((record) => record.group === name); }
function single(observations, name) {
  const records = groupRecords(observations, name);
  if (records.length !== 1 || records[0].status !== 200 || !records[0].body || typeof records[0].body !== 'object') throw new Error('API observation is incomplete');
  return records[0].body;
}
function paged(observations, name, key) {
  const records = groupRecords(observations, name);
  if (!records.length || new URL('https://api.github.com' + records[0].endpoint).searchParams.get('page') !== '1') throw new Error('API observation pages are missing');
  return completePages(records, key);
}
function normalizeConfiguration(configuration) {
  return {
    repository: pick(configuration.repository, ['id', 'full_name', 'default_branch', 'visibility', 'archived', 'disabled', 'security_and_analysis']),
    rulesets: sorted(configuration.rulesets.map((rule) => platformProtection('ruleset', rule))),
    environment: platformProtection('environment', configuration.environment),
    branchPolicies: platformProtection('branchPolicies', configuration.branchPolicies),
    actions: pick(configuration.actions, ['enabled', 'allowed_actions', 'sha_pinning_required']),
    selectedActions: { ...pick(configuration.selectedActions, ['github_owned_allowed', 'verified_allowed']), patterns_allowed: sorted(configuration.selectedActions.patterns_allowed) },
    workflowPermissions: pick(configuration.workflowPermissions, ['default_workflow_permissions', 'can_approve_pull_request_reviews']),
    deployKeys: sorted(configuration.deployKeys.map((record) => pick(record, ['id', 'key', 'read_only']))),
    collaborators: sorted(configuration.collaborators.map((record) => pick(record, ['id', 'login', 'permissions', 'role_name']))),
    app: { ...pick(configuration.app, ['id', 'slug', 'permissions']), owner: pick(configuration.app.owner, ['login', 'type']) },
    installations: sorted(configuration.installations.map((record) => ({ ...pick(record, ['id', 'app_id', 'app_slug', 'repository_selection', 'permissions', 'suspended_at']), account: pick(record.account, ['login', 'type']) }))),
  };
}
function observedConfiguration(observations) {
  const list = paged(observations, 'rulesetList');
  return normalizeConfiguration({ repository: single(observations, 'repository'), rulesets: list.map((item) => single(observations, `ruleset:${item.id}`)),
    environment: single(observations, 'environment'), branchPolicies: paged(observations, 'branchPolicies', 'branch_policies'),
    actions: single(observations, 'actions'), selectedActions: single(observations, 'selectedActions'), workflowPermissions: single(observations, 'workflowPermissions'),
    deployKeys: paged(observations, 'deployKeys'), collaborators: paged(observations, 'collaborators'), app: single(observations, 'app'), installations: paged(observations, 'installations', 'installations') });
}
export function validateBaseline(baseline) {
  if (baseline?.schema !== 'punchpilot-public-governance-baseline' || baseline.repository !== REPOSITORY || !SHA256.test(baseline.publication?.policyHash) ||
      ![baseline.appId, baseline.installationId].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error('independently reviewed governance baseline is required');
  canonicalObjects(baseline.publication);
  const configuration = normalizeConfiguration(baseline.configuration);
  if (configuration.repository.full_name !== REPOSITORY || !Number.isSafeInteger(configuration.repository.id) || configuration.repository.id < 1 ||
      configuration.repository.default_branch !== 'main' || configuration.repository.visibility !== 'public' || configuration.repository.archived !== false || configuration.repository.disabled !== false ||
      configuration.repository.security_and_analysis?.secret_scanning?.status !== 'enabled' || configuration.repository.security_and_analysis?.secret_scanning_push_protection?.status !== 'enabled') throw new Error('repository identity and push protection baseline is incomplete');
  const rulesets = configuration.rulesets.filter((rule) => rule.enforcement === 'active');
  for (const target of ['branch', 'tag']) {
    const matches = rulesets.filter((rule) => rule.target === target);
    const rule = matches[0], refs = rule?.conditions?.ref_name;
    if (matches.length !== 1 || !Number.isSafeInteger(rule.id) || rule.id < 1 || refs?.include?.length !== 1 || refs?.exclude?.length !== 0 ||
        !(target === 'branch' ? refs.include[0] === 'refs/heads/main' : ['refs/tags/v*', `refs/tags/${baseline.publication.version}`].includes(refs.include[0])) ||
        rule.bypass_actors?.length !== 1 || rule.bypass_actors[0].actor_type !== 'Integration' || rule.bypass_actors[0].actor_id !== baseline.appId || rule.bypass_actors[0].bypass_mode !== 'always' ||
        !['creation', 'update', 'deletion', 'non_fast_forward'].every((type) => rule.rules?.some((item) => item.type === type))) throw new Error('rules must bind main/tag to the sole release App');
  }
  if (rulesets.length !== 2) throw new Error('additional active rules require explicit contract review');
  const environment = configuration.environment, reviewers = environment.protection_rules.filter((rule) => rule.type === 'required_reviewers');
  if (environment.name !== 'public-release' || environment.can_admins_bypass === true || environment.deployment_branch_policy?.protected_branches !== false || environment.deployment_branch_policy?.custom_branch_policies !== true ||
      reviewers.length !== 1 || reviewers[0].prevent_self_review !== true || reviewers[0].reviewers?.length !== 1 || reviewers[0].reviewers[0].type !== 'User' || reviewers[0].reviewers[0].reviewer?.login !== 'sky-zhang01' ||
      !Number.isSafeInteger(reviewers[0].reviewers[0].reviewer?.id) || environment.protection_rules.some((rule) => !['required_reviewers', 'branch_policy', 'wait_timer'].includes(rule.type))) throw new Error('protected environment owner/self-review/admin-bypass policy is incomplete');
  if (configuration.branchPolicies.length !== 1 || configuration.branchPolicies[0].type !== 'tag' || !['v*', baseline.publication.version].includes(configuration.branchPolicies[0].name)) throw new Error('protected environment requires the reviewed tag policy');
  if (configuration.actions.enabled !== true || configuration.actions.allowed_actions !== 'selected' || configuration.actions.sha_pinning_required !== true ||
      configuration.workflowPermissions.default_workflow_permissions !== 'read' || configuration.workflowPermissions.can_approve_pull_request_reviews !== false) throw new Error('Actions settings must require SHA pins and read-only default token');
  if (configuration.selectedActions.github_owned_allowed !== false || configuration.selectedActions.verified_allowed !== false || !configuration.selectedActions.patterns_allowed.length ||
      configuration.selectedActions.patterns_allowed.some((pattern) => typeof pattern !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(pattern))) throw new Error('selected Actions require exact full SHA entries');
  if (configuration.deployKeys.some((key) => key.read_only !== true)) throw new Error('write deploy keys violate the sole public writer boundary');
  if (!configuration.collaborators.length || configuration.collaborators.some((user) => !Number.isSafeInteger(user.id) || !user.login || (user.permissions?.push !== false && user.login !== 'sky-zhang01'))) throw new Error('unexpected collaborator write authority');
  const installation = configuration.installations.find((item) => item.id === baseline.installationId);
  if (configuration.app.id !== baseline.appId || configuration.app.slug !== APP || configuration.app.owner?.login !== 'sky-zhang01' || configuration.app.owner?.type !== 'User' ||
      !installation || installation.app_id !== baseline.appId || installation.app_slug !== APP || installation.account?.login !== 'sky-zhang01' || installation.account?.type !== 'User' || installation.suspended_at !== null || installation.repository_selection !== 'selected') throw new Error('release App/installation identity baseline is incomplete');
  for (const permission of [configuration.app.permissions, installation.permissions]) {
    if (permission?.contents !== 'write' || Object.entries(permission).some(([scope, level]) => !['read', 'write'].includes(level) || (level === 'write' && !['contents', 'workflows'].includes(scope)))) throw new Error('release App has excess or missing authority');
  }
  return configuration;
}
function reviewedWorkflowPins(text) {
  const pins = []; let scalarIndent = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^ */)[0].length;
    if (scalarIndent !== null && indent > scalarIndent) continue;
    scalarIndent = null;
    if (/\t|[\0-\x08\x0b\x0c\x0e-\x1f]|^\s*(?:-\s*)?\?(?:\s|$)|^\s*(?:%|---|\.\.\.)/.test(line) ||
        /^\s*(?:-\s*)?(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:/.test(line)) throw new Error('public workflow syntax is outside the reviewed block form');
    // Expressions and single-line scalar strings are data; quoted mapping keys
    // were rejected above. This is a shape gate, not a general YAML parser.
    const plain = line.replace(/\$\{\{[^\r\n]*?\}\}/g, 'expression')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""').replace(/\s+#.*$/, '').trimEnd();
    if (/[{}]|(?:^|[\s:[,])(?:&[^&\s]|[*!][^\s])|["']/.test(plain.replaceAll('""', 'scalar')) ||
        !/^\s*(?:[A-Za-z0-9_-]+\s*:|-\s+\S)/.test(plain)) throw new Error('public workflow syntax is outside the reviewed block form');
    if (/[\[\]]/.test(plain) && !/^\s*(?:-\s*)?[A-Za-z0-9_-]+:\s*\[(?:\s*(?:[A-Za-z0-9_.-]+|"")\s*(?:,\s*(?:[A-Za-z0-9_.-]+|"")\s*)*)?\]\s*$/.test(plain)) throw new Error('public workflow flow sequence is outside the reviewed scalar form');
    if (/\buses\s*:/.test(plain)) {
      const match = line.match(/^\s*(?:-\s*)?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40})\s*(?:#.*)?$/);
      if (!match) throw new Error('public workflow action is not pinned to a full SHA in reviewed block form');
      pins.push(match[1]);
    }
    const scalar = plain.match(/^( *)(-\s+)?[A-Za-z0-9_-]+:\s*[|>][+-]?\s*$/);
    if (scalar) scalarIndent = scalar[1].length + (scalar[2]?.length || 0);
  }
  return pins;
}
export function sourceProjection(repoRoot, baseline) {
  const tuple = baseline.publication;
  const policy = parseAllowlist(gitBytes(repoRoot, ['show', `${tuple.sourceCommit}:.public-export/allowlist.json`]).toString('utf8'));
  const exported = exportPublicTree({ repoRoot, source: tuple.sourceCommit, publicBase: tuple.publicBase, policy, scan: true });
  const codeowners = gitBytes(repoRoot, ['show', `${exported.treeSha}:.github/CODEOWNERS`]).toString('utf8');
  const ownerRules = codeowners.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (ownerRules.length !== 1 || !/^\*\s+@sky-zhang01$/.test(ownerRules[0])) throw new Error('CODEOWNERS must contain exactly one reviewed global owner rule');
  const actionPins = new Set();
  for (const entry of exported.pathset.filter((name) => name.startsWith('.github/workflows/') && /\.ya?ml$/.test(name))) {
    const text = gitBytes(repoRoot, ['show', `${exported.treeSha}:${entry}`]).toString('utf8');
    for (const pin of reviewedWorkflowPins(text)) actionPins.add(pin);
  }
  return { sourceCommit: exported.sourceCommit, exportedTree: exported.treeSha, policyHash: exported.policyHash,
    privacy: exported.scanResult?.ok ? 'PASS' : 'FAIL', codeowners: true, actionPins: [...actionPins].sort() };
}
export function evaluateObservations({ observations, baseline = null, source = null }) {
  if (observations?.schema !== 'punchpilot-public-governance-observations' || !Array.isArray(observations.records) || !Array.isArray(observations.errors) ||
      observations.records.some((record) => !endpointAllowed(record.endpoint))) throw new Error('invalid private governance observations');
  if (!OID.test(observations.run?.codeCommit) || !SHA256.test(observations.run?.collectorSha256) ||
      typeof observations.run.runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(observations.run.runId) || !Number.isSafeInteger(observations.run.runAttempt) || observations.run.runAttempt < 1 ||
      Object.keys(observations.run).sort().join(',') !== 'codeCommit,collectorSha256,runAttempt,runId' || !VERSION.test(observations.version)) throw new Error('invalid observation identity');
  const expectedEndpoints = { repository: REPO, main: `${REPO}/git/ref/heads/main`, mainFinal: `${REPO}/git/ref/heads/main`,
    tag: `${REPO}/git/ref/tags/${observations.version}`, tagFinal: `${REPO}/git/ref/tags/${observations.version}`,
    environment: `${REPO}/environments/public-release`, actions: `${REPO}/actions/permissions`,
    selectedActions: `${REPO}/actions/permissions/selected-actions`, workflowPermissions: `${REPO}/actions/permissions/workflow`, app: `/apps/${APP}` };
  const pageEndpoints = { rulesetList: `${REPO}/rulesets?includes_parents=true`, branchPolicies: `${REPO}/environments/public-release/deployment-branch-policies`,
    deployKeys: `${REPO}/keys`, collaborators: `${REPO}/collaborators?affiliation=all`, installations: '/user/installations' };
  let lastTime = 0;
  for (const record of observations.records) {
    const time = Date.parse(record.observedAt);
    if (!Number.isFinite(time) || time < lastTime) throw new Error('invalid observation chronology'); lastTime = time;
    if (expectedEndpoints[record.group]) { if (record.endpoint !== expectedEndpoints[record.group]) throw new Error('observation endpoint binding mismatch'); }
    else if (pageEndpoints[record.group]) {
      const actual = new URL(`https://api.github.com${record.endpoint}`), expected = new URL(`https://api.github.com${pageEndpoints[record.group]}`);
      actual.searchParams.delete('page'); actual.searchParams.delete('per_page');
      if (actual.pathname !== expected.pathname || actual.search !== expected.search) throw new Error('observation page endpoint binding mismatch');
    } else if (record.group === 'commit') {
      const initial = groupRecords(observations, 'main')[0];
      if (!OID.test(initial?.body?.object?.sha) || record.endpoint !== `${REPO}/git/commits/${initial.body.object.sha}`) throw new Error('observation commit endpoint binding mismatch');
    } else if (/^ruleset:[1-9][0-9]*$/.test(record.group)) {
      if (record.endpoint !== `${REPO}/rulesets/${record.group.slice(8)}?includes_parents=true`) throw new Error('observation ruleset endpoint binding mismatch');
    } else throw new Error('unexpected observation endpoint group');
  }
  const checks = { publication: 'UNKNOWN', sourceExport: 'UNKNOWN', repository: 'UNKNOWN', rulesets: 'UNKNOWN', environment: 'UNKNOWN', administratorBypass: 'UNKNOWN', actions: 'UNKNOWN', access: 'UNKNOWN', appIdentity: 'UNKNOWN', installation: 'UNKNOWN', configuration: 'UNKNOWN' };
  let configurationSha256 = null;
  if (baseline) {
    const expected = validateBaseline(baseline), objects = canonicalObjects(baseline.publication);
    try {
      const main = single(observations, 'main'), final = single(observations, 'mainFinal'), tag = single(observations, 'tag'), finalTag = single(observations, 'tagFinal');
      const refsMatch = observations.version === baseline.publication.version && main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === objects.commitId &&
        stable(main) === stable(final) && tag.ref === `refs/tags/${baseline.publication.version}` && tag.object?.type === 'tag' && tag.object.sha === objects.tagId && stable(tag) === stable(finalTag);
      if (!refsMatch) checks.publication = 'FAIL';
      else { const commit = single(observations, 'commit'); checks.publication = commit.sha === objects.commitId && commit.tree?.sha === baseline.publication.exportedTree &&
        commit.parents?.length === 1 && commit.parents[0].sha === baseline.publication.publicBase ? 'PASS' : 'FAIL'; }
    } catch { /* Unknown is a rejection, not absence. */ }
    if (source) checks.sourceExport = source.sourceCommit === baseline.publication.sourceCommit && source.exportedTree === baseline.publication.exportedTree &&
      source.policyHash === baseline.publication.policyHash && source.privacy === 'PASS' && source.codeowners === true && Array.isArray(source.actionPins) &&
      source.actionPins.length > 0 && source.actionPins.every((pin) => expected.selectedActions.patterns_allowed.includes(pin)) ? 'PASS' : 'FAIL';
    const observe = {
      repository: () => ({ repository: single(observations, 'repository') }),
      rulesets: () => ({ rulesets: paged(observations, 'rulesetList').map((item) => single(observations, `ruleset:${item.id}`)) }),
      environment: () => ({ environment: single(observations, 'environment'), branchPolicies: paged(observations, 'branchPolicies', 'branch_policies') }),
      actions: () => ({ actions: single(observations, 'actions'), selectedActions: single(observations, 'selectedActions'), workflowPermissions: single(observations, 'workflowPermissions') }),
      access: () => ({ deployKeys: paged(observations, 'deployKeys'), collaborators: paged(observations, 'collaborators') }),
      appIdentity: () => ({ app: single(observations, 'app') }),
      installation: () => ({ installations: paged(observations, 'installations', 'installations') }),
    };
    for (const [name, read] of Object.entries(observe)) {
      try {
        if (name === 'actions' && stable(pick(single(observations, 'actions'), ['enabled', 'allowed_actions', 'sha_pinning_required'])) !== stable(expected.actions)) { checks.actions = 'FAIL'; continue; }
        const component = read(), actual = normalizeConfiguration({ ...expected, ...component });
        checks[name] = Object.keys(component).every((key) => stable(actual[key]) === stable(expected[key])) ? 'PASS' : 'FAIL';
      } catch { /* Missing visibility/fields/pages cannot prove protection. */ }
    }
    try {
      const bypass = single(observations, 'environment').can_admins_bypass;
      checks.administratorBypass = bypass === false ? 'PASS' : bypass === true ? 'FAIL' : 'UNKNOWN';
    } catch { /* The documented environment REST schema does not expose this field. */ }
    const parts = [...Object.keys(observe).map((key) => checks[key]), checks.administratorBypass];
    checks.configuration = parts.includes('FAIL') ? 'FAIL' : parts.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
    try { configurationSha256 = digest(stable(observedConfiguration(observations))); } catch { /* Incomplete configuration has no full attestation digest. */ }
  }
  const status = Object.values(checks).includes('FAIL') ? 'FAIL' : Object.values(checks).includes('UNKNOWN') || observations.errors.length ? 'UNKNOWN' : 'PASS';
  return { schema: 'punchpilot-public-governance-report', status, checks, configurationSha256, authorizesPublication: false,
    privacyHistory: 'NOT_CHECKED', installationAuthority: checks.configuration === 'PASS' ? 'OBSERVED_METADATA_ONLY' : 'UNKNOWN' };
}
function summaryFor({ observations, report, baselineSha256, hashes }) {
  return { schema: 'punchpilot-public-governance-summary', run: observations.run, version: observations.version, baselineSha256,
    status: report.status, checks: report.checks, configurationSha256: report.configurationSha256, authorizesPublication: false,
    privacyHistory: report.privacyHistory, evidenceSha256: digest(jsonBytes(hashes)) };
}
export function writeEvidence({ directory, observations, report, source = null, baselineSha256 = null }) {
  if (fs.existsSync(directory)) throw new Error('governance evidence requires a fresh directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  const files = { 'observations.json': observations, 'report.json': report, 'source.json': source }, hashes = {};
  for (const [name, value] of Object.entries(files)) { const bytes = jsonBytes(value); durableFile(path.join(directory, name), bytes); hashes[name] = digest(bytes); }
  const manifest = { schema: 'punchpilot-public-governance-evidence', baselineSha256, hashes };
  durableFile(path.join(directory, 'manifest.json'), jsonBytes(manifest));
  durableFile(path.join(directory, 'summary.json'), jsonBytes(summaryFor({ observations, report, baselineSha256, hashes })));
}
export function verifyEvidence({ directory, baseline = null, baselineSha256 = null, source = null }) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || metadata.mode & 0o077) throw new Error('governance evidence must be private');
  if (fs.readdirSync(directory).sort().join('\n') !== ['manifest.json', 'observations.json', 'report.json', 'source.json', 'summary.json'].join('\n')) throw new Error('unexpected governance evidence inventory');
  const manifest = readPrivateJson(path.join(directory, 'manifest.json'));
  if (manifest.schema !== 'punchpilot-public-governance-evidence' || manifest.baselineSha256 !== baselineSha256 ||
      (baseline && digest(jsonBytes(baseline)) !== baselineSha256) || (!baseline && baselineSha256 !== null)) throw new Error('governance baseline is not independently pinned');
  for (const name of ['observations.json', 'report.json', 'source.json']) if (digest(privateFile(path.join(directory, name), null, LIMIT)) !== manifest.hashes?.[name]) throw new Error('governance evidence digest readback failed');
  const observationBytes = privateFile(path.join(directory, 'observations.json'), null, LIMIT);
  const observations = JSON.parse(observationBytes);
  if (!jsonBytes(observations).equals(observationBytes)) throw new Error('private observations are noncanonical');
  if (observations.run?.collectorSha256 !== digest(fs.readFileSync(fileURLToPath(import.meta.url)))) throw new Error('governance collector code readback changed');
  const storedSource = readPrivateJson(path.join(directory, 'source.json'));
  if (stable(source) !== stable(storedSource)) throw new Error('source/export verification readback changed');
  const report = evaluateObservations({ observations, baseline, source });
  if (!jsonBytes(report).equals(privateFile(path.join(directory, 'report.json'))) ||
      !jsonBytes(summaryFor({ observations, report, baselineSha256, hashes: manifest.hashes })).equals(privateFile(path.join(directory, 'summary.json')))) throw new Error('governance decision/summary readback failed');
  return report;
}
function optionsFor(argv) {
  const [command, ...args] = argv, options = {};
  if (!['observe', 'check', 'verify'].includes(command)) throw new Error('usage: public-governance-check.mjs observe|check|verify --evidence DIR [--baseline FILE --baseline-sha256 SHA256] [--version vX.Y.Z --run-id ID --run-attempt N --code-commit SHA]');
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!['--evidence', '--baseline', '--baseline-sha256', '--version', '--run-id', '--run-attempt', '--code-commit'].includes(name) || !value || value.startsWith('--') || Object.hasOwn(options, name)) throw new Error('invalid governance CLI argument');
    options[name] = value;
  }
  if (!options['--evidence'] || (command === 'check' && (!options['--baseline'] || !options['--baseline-sha256'])) ||
      Boolean(options['--baseline']) !== Boolean(options['--baseline-sha256']) || (command === 'observe' && options['--baseline'])) throw new Error('governance evidence and independently pinned baseline are required');
  return { command, options };
}
async function main(argv) {
  const { command, options } = optionsFor(argv);
  const root = fs.realpathSync(process.cwd());
  const requested = path.resolve(options['--evidence']);
  const directory = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error('private governance evidence must remain outside the source repository');
  let baseline = null, baselineSha256 = options['--baseline-sha256'] || null, source = null;
  if (options['--baseline']) {
    const bytes = privateFile(options['--baseline'], root);
    if (!SHA256.test(baselineSha256) || digest(bytes) !== baselineSha256) throw new Error('governance baseline digest does not match independent review');
    baseline = readPrivateJson(options['--baseline'], root); validateBaseline(baseline);
    source = sourceProjection(root, baseline);
  }
  let report;
  if (command === 'verify') report = verifyEvidence({ directory, baseline, baselineSha256, source });
  else {
    const codeCommit = gitText(root, ['rev-parse', 'HEAD^{commit}']);
    if (options['--code-commit'] && options['--code-commit'] !== codeCommit) throw new Error('checked out governance code does not match requested commit');
    const observations = await collectObservations({ api: (request) => githubRead({ ...request, token: process.env.PUNCHPILOT_PUBLIC_GOVERNANCE_TOKEN }),
      version: baseline?.publication.version || options['--version'],
      run: { codeCommit, runId: options['--run-id'], runAttempt: Number(options['--run-attempt']) } });
    report = evaluateObservations({ observations, baseline, source });
    writeEvidence({ directory, observations, report, source, baselineSha256 });
    report = verifyEvidence({ directory, baseline, baselineSha256, source });
  }
  console.log(JSON.stringify({ status: report.status, checks: report.checks, authorizesPublication: false }));
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2)).catch(() => {
  // Errors can originate in privacy scans and must not leak source/private details.
  console.error('public governance check rejected; inspect private evidence and reviewed inputs'); process.exitCode = 1;
});
