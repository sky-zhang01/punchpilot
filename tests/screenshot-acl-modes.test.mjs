// Some filesystems apply inherited ACLs that widen the mode requested at
// creation (seen on TrueNAS datasets with NFSv4 ACLs: mkdir 0700 and a 0600
// file both came out 0770). These tests widen creation modes the same way and
// check that the screenshot directory claim still ends up private.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureScreenshotsDir,
  SCREENSHOT_ROOT_MARKER,
} from '../server/automation/constants.js';

const roots = [];
const identity = `log-v1:${'d'.repeat(64)}`;

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pp-screenshot-acl-'));
  roots.push(root);
  return root;
}

function widenCreationModes() {
  const mkdirSync = fs.mkdirSync.bind(fs);
  const openSync = fs.openSync.bind(fs);
  vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
    const created = mkdirSync(target, options);
    if (created !== undefined) fs.chmodSync(target, 0o770);
    return created;
  });
  vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
    const descriptor = openSync(target, flags, mode);
    if (typeof flags === 'number' && (flags & fs.constants.O_CREAT)) fs.fchmodSync(descriptor, 0o770);
    return descriptor;
  });
}

const modeOf = (file) => fs.lstatSync(file).mode & 0o777;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('screenshot directory under inherited ACLs', () => {
  it('claims a new root and creates a private marker', () => {
    const root = path.join(scratchRoot(), 'screenshots');
    widenCreationModes();

    expect(ensureScreenshotsDir(root)).toBe(path.resolve(root));

    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(path.join(root, SCREENSHOT_ROOT_MARKER))).toBe(0o600);
  });

  it('creates a private per-account directory', () => {
    const root = scratchRoot();
    ensureScreenshotsDir(root);
    widenCreationModes();

    const identityRoot = ensureScreenshotsDir(root, identity);

    expect(modeOf(identityRoot)).toBe(0o700);
  });

  it('tightens an own marker whose mode an ACL widened', () => {
    const root = scratchRoot();
    ensureScreenshotsDir(root);
    const marker = path.join(root, SCREENSHOT_ROOT_MARKER);
    fs.chmodSync(marker, 0o660);

    expect(ensureScreenshotsDir(root)).toBe(path.resolve(root));
    expect(modeOf(marker)).toBe(0o600);
  });

  it('still rejects a marker with unexpected content', () => {
    const root = scratchRoot();
    ensureScreenshotsDir(root);
    const marker = path.join(root, SCREENSHOT_ROOT_MARKER);
    fs.writeFileSync(marker, 'not the marker\n');

    expect(() => ensureScreenshotsDir(root)).toThrowError(
      expect.objectContaining({ code: 'SCREENSHOT_DIRECTORY_UNSAFE' }),
    );
  });

  it('still rejects a pre-existing group-writable per-account directory', () => {
    const root = scratchRoot();
    ensureScreenshotsDir(root);
    const identityRoot = path.join(root, identity);
    fs.mkdirSync(identityRoot, { mode: 0o700 });
    fs.chmodSync(identityRoot, 0o770);

    expect(() => ensureScreenshotsDir(root, identity)).toThrowError(
      expect.objectContaining({ code: 'SCREENSHOT_DIRECTORY_UNSAFE' }),
    );
  });
});
