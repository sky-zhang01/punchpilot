// Runs the public image workflow's archive hand-off between jobs: package the
// scanned images, upload and download the artifacts, then verify, test, unpack and
// load them, using the workflow's own commands with `docker` replaced by a stub.
// These steps only run after a release tag is public, so an unsupported flag or a
// file name that does not match across jobs would otherwise surface too late to
// fix without a new version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.resolve('.github/workflows/docker-publish.yml'), 'utf8').split('\n');
const zstdAvailable = spawnSync('zstd', ['--version'], { encoding: 'utf8' }).status === 0;
const runIt = zstdAvailable || process.env.CI === 'true' ? it : it.skip;
const roots = [];

const isZstdLine = (line) => /(^|\|\s*)zstd\s/.test(line.trim());

function job(name) {
  const start = workflow.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`job not found: ${name}`);
  let end = start + 1;
  while (end < workflow.length && !/^ {2}\S/.test(workflow[end])) end++;
  return workflow.slice(start, end);
}

// Returns the indented lines that belong to one named step of a job.
function step(jobName, title) {
  const lines = job(jobName);
  const start = lines.findIndex((line) => line.trim() === `- name: ${title}`);
  if (start === -1) throw new Error(`step not found: ${jobName} / ${title}`);
  const indent = lines[start].indexOf('-');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    body.push(line);
  }
  return body;
}

// Reads a `key: value` or `key: |` block from a step body.
function field(body, key) {
  const index = body.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (index === -1) throw new Error(`field not found: ${key}`);
  const value = body[index].trim().slice(key.length + 1).trim();
  if (value !== '|') return value;
  const indent = body[index].search(/\S/);
  const block = [];
  for (const line of body.slice(index + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    block.push(line.trim());
  }
  return block.join('\n').trim();
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pp-archive-'));
  roots.push(dir);
  return dir;
}

const dockerStub = `docker() {
  case "$1 $2" in
    "save "*) printf 'image %s\\n' "$2" ;;
    "load --input") cat "$3" >> "$PP_LOADED" ;;
    "image inspect")
      grep -qx "image $3" "$PP_LOADED" || return 1
      if [ "\${4:-}" = --format ]; then printf '%s\\n' "\${3##*:}"; fi ;;
    "buildx version") ;;
    *) echo "unexpected docker call: $*" >&2; return 1 ;;
  esac
}
`;

afterAll(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('public image archive hand-off', () => {
  const pack = ['build-and-scan', 'Package scanned release candidates'];
  const uploads = ['amd64', 'arm64'].map((arch) => ['build-and-scan', `Upload scanned ${arch} candidate`]);
  const consumers = [
    { job: 'verify-arm64-runtime', downloads: ['arm64'], verify: 'Verify and load arm64 candidate', images: ['arm64'] },
    { job: 'publish-image', downloads: ['amd64', 'arm64'], verify: 'Verify and load scanned candidates', images: ['amd64', 'arm64'] },
  ];

  it('keeps checksum verification and strict uploads around the archives', () => {
    for (const upload of uploads) expect(field(step(...upload), 'if-no-files-found'), upload[1]).toBe('error');
    for (const consumer of consumers) {
      const run = field(step(consumer.job, consumer.verify), 'run');
      for (const arch of consumer.downloads) {
        const check = run.indexOf(`sha256sum --check punchpilot-${arch}.sha256`);
        expect(check, `${consumer.job} verifies the ${arch} checksum`).toBeGreaterThan(-1);
        expect(check, `${consumer.job} verifies before unpacking`).toBeLessThan(run.indexOf(`zstd --test punchpilot-${arch}.tar.zst`));
      }
    }
  });

  it('runs every zstd command of the workflow in the simulated hand-off', () => {
    const executed = [pack, ...consumers.map((consumer) => [consumer.job, consumer.verify])]
      .flatMap(([jobName, title]) => field(step(jobName, title), 'run').split('\n'))
      .filter(isZstdLine);
    expect(executed).toHaveLength(workflow.filter(isZstdLine).length);
    expect(executed.filter((line) => line.startsWith('docker save '))).toHaveLength(2);
    expect(executed.filter((line) => line.startsWith('zstd --test '))).toHaveLength(3);
    expect(executed.filter((line) => line.startsWith('zstd --decompress '))).toHaveLength(3);
  });

  runIt('packs, transfers, verifies and loads the candidates with the workflow commands', () => {
    expect(zstdAvailable, 'CI runners must provide zstd to test the public image archive commands').toBe(true);
    // Each job runs on its own runner, so each gets a separate /tmp.
    const localPath = (root, text) => text.replace(/\/tmp(?=\/|\s|$)/g, `${root}/tmp`);
    const run = (root, body) => {
      // Pass GitHub expressions to these steps through env, as the workflow does
      // elsewhere; inline expressions would not run outside GitHub Actions.
      expect(field(body, 'run'), 'archive run blocks must not use inline ${{ }} expressions').not.toContain('${{');
      const result = spawnSync('bash', ['-c', `set -eo pipefail\n${dockerStub}${localPath(root, field(body, 'run'))}`], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PP_LOADED: path.join(root, 'loaded-images') },
      });
      expect(result.status, `${field(body, 'run')}\n${result.stderr}`).toBe(0);
    };

    // The scan steps write one SBOM per architecture where the package step expects it.
    const producer = scratch();
    const sboms = job('build-and-scan').map((line) => line.match(/trivy image .*--format cyclonedx --output (\S+)/)?.[1]).filter(Boolean);
    expect(sboms).toHaveLength(2);
    for (const sbom of sboms) {
      fs.mkdirSync(path.dirname(localPath(producer, sbom)), { recursive: true });
      fs.writeFileSync(localPath(producer, sbom), `{"sbom":"${path.basename(sbom)}"}\n`);
    }
    run(producer, step(...pack));

    // upload-artifact roots several paths at their nearest common directory and keeps
    // the relative layout below it.
    const artifacts = new Map();
    for (const upload of uploads) {
      const body = step(...upload);
      const files = field(body, 'path').split('\n').map((file) => localPath(producer, file));
      for (const file of files) expect(fs.existsSync(file), `${upload[1]}: ${file}`).toBe(true);
      let base = path.dirname(files[0]);
      while (base !== path.dirname(base) && !files.every((file) => file.startsWith(`${base}/`))) base = path.dirname(base);
      artifacts.set(field(body, 'name'), files.map((file) => ({ file, relative: path.relative(base, file) })));
    }

    for (const consumer of consumers) {
      const root = scratch();
      for (const arch of consumer.downloads) {
        const body = step(consumer.job, `Download scanned ${arch} candidate`);
        const files = artifacts.get(field(body, 'name'));
        expect(files, `${consumer.job} downloads an artifact that was uploaded`).toBeDefined();
        const target = localPath(root, field(body, 'path'));
        for (const { file, relative } of files) {
          fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
          fs.copyFileSync(file, path.join(target, relative));
        }
      }
      run(root, step(consumer.job, consumer.verify));
      expect(fs.readFileSync(path.join(root, 'loaded-images'), 'utf8').trim().split('\n')).toEqual(
        consumer.images.map((arch) => `image punchpilot-release-scan:${arch}`),
      );
      // Later steps attest the downloaded SBOMs by path.
      for (const sbom of job(consumer.job).map((line) => line.match(/sbom-path: (\S+)/)?.[1]).filter(Boolean)) {
        expect(fs.existsSync(localPath(root, sbom)), `${consumer.job}: ${sbom}`).toBe(true);
      }
    }
  });
});
