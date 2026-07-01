#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

const root = process.cwd();
const tag = argValue('--tag') || process.env.GITHUB_REF_NAME || '';
const mode = argValue('--mode') || 'local';
const rootPkg = readJson(path.join(root, 'package.json'));
const clientPkg = readJson(path.join(root, 'client', 'package.json'));
const rootLock = readJson(path.join(root, 'package-lock.json'));
const clientLock = readJson(path.join(root, 'client', 'package-lock.json'));
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const expectedTag = `v${rootPkg.version}`;

if (!/^\d+\.\d+\.\d+$/.test(rootPkg.version)) {
  fail(`package.json version is not semver: ${rootPkg.version}`);
}

if (clientPkg.version !== rootPkg.version) {
  fail(`client/package.json version ${clientPkg.version} does not match ${rootPkg.version}`);
}

if (rootLock.version !== rootPkg.version || rootLock.packages?.['']?.version !== rootPkg.version) {
  fail(`package-lock.json version metadata does not match ${rootPkg.version}`);
}

if (clientLock.version !== rootPkg.version || clientLock.packages?.['']?.version !== rootPkg.version) {
  fail(`client/package-lock.json version metadata does not match ${rootPkg.version}`);
}

if (tag && tag !== expectedTag) {
  fail(`tag ${tag} does not match package version ${expectedTag}`);
}

if (!dockerfile.includes(`org.opencontainers.image.version="${rootPkg.version}"`)) {
  fail(`Dockerfile OCI version label does not match ${rootPkg.version}`);
}

if (!changelog.includes(`## [${rootPkg.version}]`)) {
  fail(`CHANGELOG.md is missing section [${rootPkg.version}]`);
}

const releaseHeadings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm)];
if (releaseHeadings.length === 0) {
  fail('CHANGELOG.md does not contain a release section');
} else {
  const firstHeading = releaseHeadings[0];
  const firstVersion = firstHeading[1];
  const bodyStart = firstHeading.index + firstHeading[0].length;
  const bodyEnd = releaseHeadings[1]?.index ?? changelog.length;
  const body = changelog.slice(bodyStart, bodyEnd);
  if (firstVersion !== rootPkg.version) {
    fail(`CHANGELOG.md first release section ${firstVersion} does not match ${rootPkg.version}`);
  }
  if (!/^### /m.test(body) || !/^- /m.test(body)) {
    fail(`CHANGELOG.md section [${rootPkg.version}] has no categorized release notes`);
  }
}

if (mode === 'public' && process.env.GITHUB_SERVER_URL && process.env.GITHUB_SERVER_URL !== 'https://github.com') {
  fail(`public release mode must run on GitHub, got ${process.env.GITHUB_SERVER_URL}`);
}

if (hasArg('--require-handoff')) {
  if (!tag) {
    fail('release handoff marker requires a tag');
  } else {
    let tagType = '';
    let tagBody = '';
    try {
      const { execFileSync } = await import('node:child_process');
      tagType = execFileSync('git', ['cat-file', '-t', `refs/tags/${tag}`], { encoding: 'utf8' }).trim();
      tagBody = execFileSync('git', ['for-each-ref', `refs/tags/${tag}`, '--format=%(contents)'], { encoding: 'utf8' });
    } catch (error) {
      fail(`could not inspect release tag ${tag}: ${error.message}`);
    }
    if (tagType !== 'tag') {
      fail(`tag ${tag} must be an annotated tag for public release handoff`);
    }
    if (!/^Internal-Release-Check: passed$/m.test(tagBody)) {
      fail(`tag ${tag} is missing Internal-Release-Check: passed handoff marker`);
    }
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`OK - release metadata matches ${expectedTag} (${mode}).`);
