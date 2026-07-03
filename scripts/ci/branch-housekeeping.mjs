#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production']);
const DELETE_CONFIRMATION = '--confirm-delete-merged-branches';

function parseArgs(argv) {
  const args = {
    bases: new Map(),
    deleteLocal: false,
    deleteRemote: false,
    fetch: false,
    includeLocal: false,
    remotes: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fetch') {
      args.fetch = true;
    } else if (arg === '--include-local') {
      args.includeLocal = true;
    } else if (arg === '--delete-local') {
      args.deleteLocal = true;
    } else if (arg === '--delete-remote') {
      args.deleteRemote = true;
    } else if (arg === '--remote') {
      args.remotes.push(requireValue(argv, index, arg));
      index += 1;
    } else if (arg === '--base') {
      const value = requireValue(argv, index, arg);
      const [remote, base] = value.includes(':') ? value.split(':', 2) : ['*', value];
      args.bases.set(remote, base);
      index += 1;
    } else if (arg === DELETE_CONFIRMATION) {
      args.confirmed = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${arg} requires a value`);
  }
  return value;
}

function runGit(args, options = {}) {
  const output = execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
  return typeof output === 'string' ? output.trim() : '';
}

function gitOk(args) {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`[WARN] ${message}`);
}

function printUsage() {
  console.log(`Usage: npm run housekeeping:branches -- [options]

Reports merged branch cleanup candidates. Deletes only when explicitly requested.

Options:
  --fetch                                   Run git fetch --all --prune first.
  --remote <name>                           Inspect one remote. Repeatable.
  --base [remote:]<ref>                     Base ref. Default is <remote>/main.
  --include-local                           Also report local branches merged into origin/main.
  --delete-local                            Delete merged local candidates.
  --delete-remote                           Delete merged remote candidates.
  ${DELETE_CONFIRMATION}          Required with delete flags.
`);
}

function listRemotes(selectedRemotes) {
  if (selectedRemotes.length > 0) return selectedRemotes;
  const output = runGit(['remote']);
  return output ? output.split('\n').filter(Boolean) : [];
}

function refExists(ref) {
  return gitOk(['rev-parse', '--verify', '--quiet', ref]);
}

function baseForRemote(remote, bases) {
  const configured = bases.get(remote) || bases.get('*');
  if (configured) return configured;
  const mainRef = `${remote}/main`;
  return refExists(mainRef) ? mainRef : '';
}

function listRemoteBranches(remote) {
  const output = runGit([
    'for-each-ref',
    '--format=%(refname:short)|%(objectname:short)|%(committerdate:short)|%(subject)',
    `refs/remotes/${remote}`,
  ]);
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, date, ...subjectParts] = line.split('|');
      return {
        branch: ref.slice(remote.length + 1),
        date,
        ref,
        remote,
        sha,
        subject: subjectParts.join('|'),
      };
    })
    .filter((branch) => branch.branch && branch.branch !== 'HEAD');
}

function listLocalBranches() {
  const output = runGit([
    'for-each-ref',
    '--format=%(refname:short)|%(objectname:short)|%(committerdate:short)|%(subject)',
    'refs/heads',
  ]);
  if (!output) return [];
  const current = runGit(['branch', '--show-current']);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [branch, sha, date, ...subjectParts] = line.split('|');
      return {
        branch,
        date,
        ref: branch,
        sha,
        subject: subjectParts.join('|'),
      };
    })
    .filter((branch) => branch.branch !== current);
}

function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(branch);
}

function isMerged(ref, baseRef) {
  return gitOk(['merge-base', '--is-ancestor', ref, baseRef]);
}

function collectRemoteCandidates(remotes, bases) {
  const candidates = [];
  const retained = [];

  for (const remote of remotes) {
    const base = baseForRemote(remote, bases);
    if (!base) {
      warn(`skipping ${remote}: no base ref configured and ${remote}/main is unavailable`);
      continue;
    }

    for (const branch of listRemoteBranches(remote)) {
      if (isProtectedBranch(branch.branch)) {
        retained.push({ ...branch, base, reason: 'protected' });
      } else if (isMerged(branch.ref, base)) {
        candidates.push({ ...branch, base, kind: 'remote' });
      } else {
        retained.push({ ...branch, base, reason: 'not merged' });
      }
    }
  }

  return { candidates, retained };
}

function collectLocalCandidates(base) {
  if (!base || !refExists(base)) {
    warn(`skipping local branches: base ref ${base || '<empty>'} is unavailable`);
    return { candidates: [], retained: [] };
  }

  const candidates = [];
  const retained = [];
  for (const branch of listLocalBranches()) {
    if (isProtectedBranch(branch.branch)) {
      retained.push({ ...branch, base, reason: 'protected' });
    } else if (isMerged(branch.ref, base)) {
      candidates.push({ ...branch, base, kind: 'local' });
    } else {
      retained.push({ ...branch, base, reason: 'not merged' });
    }
  }
  return { candidates, retained };
}

function printCandidates(title, candidates) {
  console.log(`\n${title}`);
  if (candidates.length === 0) {
    console.log('  none');
    return;
  }
  for (const item of candidates) {
    const scope = item.kind === 'remote' ? `${item.remote}/` : '';
    console.log(`  ${scope}${item.branch} ${item.sha} ${item.date} -> ${item.base}`);
    if (item.subject) console.log(`    ${item.subject}`);
  }
}

function deleteRemoteCandidates(candidates) {
  for (const item of candidates) {
    console.log(`[DELETE remote] ${item.remote}/${item.branch}`);
    runGit(['push', item.remote, '--delete', item.branch], { stdio: 'inherit' });
  }
}

function deleteLocalCandidates(candidates) {
  for (const item of candidates) {
    console.log(`[DELETE local] ${item.branch}`);
    runGit(['branch', '-D', item.branch], { stdio: 'inherit' });
  }
}

const args = parseArgs(process.argv.slice(2));

if ((args.deleteLocal || args.deleteRemote) && !args.confirmed) {
  fail(`${DELETE_CONFIRMATION} is required with delete flags`);
}

if (args.fetch) {
  runGit(['fetch', '--all', '--prune', '--tags'], { stdio: 'inherit' });
}

const remotes = listRemotes(args.remotes);
const remoteResult = collectRemoteCandidates(remotes, args.bases);
const localBase = args.bases.get('local') || args.bases.get('*') || 'origin/main';
const localResult = args.includeLocal
  ? collectLocalCandidates(localBase)
  : { candidates: [], retained: [] };

printCandidates('Merged remote branch cleanup candidates:', remoteResult.candidates);
if (args.includeLocal) {
  printCandidates('Merged local branch cleanup candidates:', localResult.candidates);
}

if (args.deleteRemote) {
  deleteRemoteCandidates(remoteResult.candidates);
}

if (args.deleteLocal) {
  deleteLocalCandidates(localResult.candidates);
}

const retainedCount = remoteResult.retained.length + localResult.retained.length;
const candidateCount = remoteResult.candidates.length + localResult.candidates.length;
console.log(`\nSummary: ${candidateCount} candidate(s), ${retainedCount} retained branch(es).`);
