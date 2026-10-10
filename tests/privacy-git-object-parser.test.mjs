import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(projectRoot, 'scripts', 'ci', 'public-release-privacy-gate.py');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('privacy gate Git object inventory compatibility', () => {
  it('scans commit ranges with NUL-safe tree entries on Git 2.47+', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'punchpilot-privacy-git-'));

    try {
      git(root, 'init', '--quiet');
      git(root, 'config', 'user.name', 'Public Fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      git(root, 'config', 'commit.gpgsign', 'false');
      git(root, 'config', 'tag.gpgsign', 'false');
      writeFileSync(path.join(root, 'base.txt'), 'public fixture\n');
      git(root, 'add', '--all');
      git(root, 'commit', '--quiet', '-m', 'test: create public fixture');
      const base = git(root, 'rev-parse', 'HEAD');

      writeFileSync(path.join(root, 'public\nfixture.txt'), 'public fixture with a newline path\n');
      git(root, 'add', '--all');
      git(root, 'commit', '--quiet', '-m', 'test: add NUL-safe path fixture');

      const result = spawnSync(
        'python3',
        [gate, '--root', root, '--ref', 'HEAD', '--commit-range', `${base}..HEAD`],
        { cwd: projectRoot, encoding: 'utf8' },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies verified SSH commit signatures without exempting disclosures or tampered signatures', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'punchpilot-privacy-signed-git-'));
    const signing = mkdtempSync(path.join(tmpdir(), 'punchpilot-privacy-signing-'));
    try {
      const key = path.join(signing, 'fixture');
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
      git(root, 'init', '--quiet');
      git(root, 'config', 'user.name', 'Public Fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      git(root, 'config', 'gpg.format', 'ssh');
      git(root, 'config', 'gpg.ssh.program', '/usr/bin/ssh-keygen');
      git(root, 'config', 'user.signingkey', key);
      git(root, 'config', 'commit.gpgsign', 'true');
      writeFileSync(path.join(root, 'public.txt'), 'public fixture\n');
      git(root, 'add', '--all');
      git(root, 'commit', '--quiet', '-m', 'test: signed public fixture');
      const signed = git(root, 'rev-parse', 'HEAD');
      const scan = (commit, env = {}) => spawnSync('/usr/bin/python3', [gate, '--root', root,
        '--commit-range', commit, '--fail-on-warn'], {
        encoding: 'utf8', env: { ...process.env, ...env },
      });
      const valid = scan(signed);
      expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);

      const raw = execFileSync('git', ['cat-file', 'commit', signed], { cwd: root });
      const signatureHeader = /gpgsig ([^\n]*(?:\n [^\n]*)*)/.exec(raw.toString())[1];
      const signatureArmor = signatureHeader.replace(/\n /g, '\n');
      const packet = Buffer.from(signatureArmor.split('\n').slice(1, -1).join(''), 'base64');
      const fields = [];
      let offset = 10;
      for (let index = 0; index < 5; index++) {
        const size = packet.readUInt32BE(offset);
        fields.push(packet.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
      fields[2] = Buffer.from(`ghp_${'A1'.repeat(20)}`);
      const reservedPacket = Buffer.concat([packet.subarray(0, 10), ...fields.flatMap((field) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(field.length);
        return [size, field];
      })]);
      const reservedArmor = `-----BEGIN SSH SIGNATURE-----\n${reservedPacket.toString('base64')}\n-----END SSH SIGNATURE-----\n`;
      const signatureFile = path.join(signing, 'reserved.signature');
      writeFileSync(signatureFile, reservedArmor);
      const unsigned = Buffer.from(raw.toString().replace(/gpgsig [^\n]*(?:\n [^\n]*)*\n/, ''));
      const reservedVerified = spawnSync('/usr/bin/ssh-keygen', ['-Y', 'check-novalidate', '-n', 'git', '-s', signatureFile], {
        input: unsigned,
      });
      expect(reservedVerified.status).toBe(0);
      const reserved = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
        cwd: root, input: Buffer.from(raw.toString().replace(
          /gpgsig [^\n]*(?:\n [^\n]*)*/, `gpgsig ${reservedArmor.trimEnd().replace(/\n/g, '\n ')}`,
        )), encoding: 'utf8',
      }).trim();
      expect(scan(reserved).status).toBe(1);
      const tampered = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
        cwd: root, input: Buffer.from(raw.toString().replace('signed public fixture', 'changed public fixture')),
        encoding: 'utf8',
      }).trim();
      const invalid = scan(tampered);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toContain('unclassified high-entropy credential');
      const malformedHeader = [
        'gpgsig -----BEGIN SSH SIGNATURE-----', ` ${'A'.repeat(64)}`, ' -----END SSH SIGNATURE-----',
      ].join('\n');
      const malformed = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
        cwd: root, input: Buffer.from(raw.toString().replace(/gpgsig [^\n]*(?:\n [^\n]*)*/, malformedHeader)),
        encoding: 'utf8',
      }).trim();
      expect(scan(malformed).status).toBe(1);

      const privatePath = ['/Users', 'private-fixture', 'private-project'].join('/');
      git(root, 'commit', '--quiet', '--allow-empty', '-m', `test: signed path ${privatePath}`);
      const disclosed = scan('HEAD');
      expect(disclosed.status).toBe(1);
      expect(disclosed.stdout).toContain('macOS home path');
      expect(disclosed.stdout).not.toContain(privatePath);

      const unavailable = scan(signed, { PATH: signing });
      expect(unavailable.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(signing, { recursive: true, force: true });
    }
  });

  it.skipIf(spawnSync('gpg', ['--version']).status !== 0)(
    'classifies verified OpenPGP commit signatures only when the exact payload and public key verify', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'punchpilot-privacy-pgp-git-'));
      const keyring = mkdtempSync('/tmp/pp-pgp-keyring-');
      const emptyKeyring = mkdtempSync('/tmp/pp-pgp-empty-');
      const env = { ...process.env, GNUPGHOME: keyring };
      try {
        const gpgVersion = execFileSync('gpg', ['--version'], { encoding: 'utf8' });
        const version = /gpg \(GnuPG\) (\d+)\.(\d+)/.exec(gpgVersion);
        const suppressManufacturer = version && (Number(version[1]) > 2 || Number(version[2]) >= 5);
        writeFileSync(path.join(keyring, 'gpg.conf'),
          `disable-signer-uid\n${suppressManufacturer ? 'compatibility-flags no-manu\n' : ''}`);
        execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '',
          '--quick-generate-key', 'Public Fixture <fixture@example.invalid>', 'ed25519', 'sign', '0'], {
          env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        git(root, 'init', '--quiet');
        git(root, 'config', 'user.name', 'Public Fixture');
        git(root, 'config', 'user.email', 'fixture@example.invalid');
        git(root, 'config', 'gpg.format', 'openpgp');
        git(root, 'config', 'gpg.program', 'gpg');
        git(root, 'config', 'user.signingkey', 'fixture@example.invalid');
        git(root, 'config', 'commit.gpgsign', 'true');
        writeFileSync(path.join(root, 'public.txt'), 'public fixture\n');
        git(root, 'add', '--all');
        execFileSync('git', ['commit', '--quiet', '-m', 'test: signed public fixture'], { cwd: root, env });
        const signed = git(root, 'rev-parse', 'HEAD');
        const scan = (commit, keyHome = keyring) => spawnSync('/usr/bin/python3', [gate, '--root', root,
          '--commit-range', commit, '--fail-on-warn'], {
          encoding: 'utf8', env: { ...process.env, GNUPGHOME: keyHome },
        });
        const valid = scan(signed);
        expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
        expect(scan(signed, emptyKeyring).status).toBe(1);

        const raw = execFileSync('git', ['cat-file', 'commit', signed], { cwd: root });
        const paddedArmor = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
          cwd: root, input: Buffer.from(raw.toString().replace(
            '-----END PGP SIGNATURE-----\n', '-----END PGP SIGNATURE-----\n \n',
          )), encoding: 'utf8',
        }).trim();
        const padded = scan(paddedArmor);
        expect(padded.status, `${padded.stdout}${padded.stderr}`).toBe(0);
        const separator = raw.indexOf(Buffer.from('\n\n'));
        let signatureHeader = false;
        const unsignedHeaders = raw.subarray(0, separator).toString().split('\n').filter((line) => {
          if (!line.startsWith(' ')) signatureHeader = line.startsWith('gpgsig ');
          return !signatureHeader;
        });
        const message = raw.subarray(separator + 2);
        const unsigned = Buffer.concat([Buffer.from(`${unsignedHeaders.join('\n')}\n\n`), message]);
        const subpacketProbe = spawnSync('/usr/bin/python3', ['-c', `
import base64, hashlib, json, os, subprocess, sys, tempfile, textwrap
from pathlib import Path
root = Path(sys.argv[2]); signed = sys.argv[3]
raw = subprocess.check_output(['git', 'cat-file', 'commit', signed], cwd=root)
headers, separator, message = raw.partition(b'\\n\\n')
keep, armor_lines, selected = [], [], False
for line in headers.split(b'\\n'):
 if not line.startswith(b' '): selected = line.startswith(b'gpgsig ')
 if selected: armor_lines.append(line[7:] if line.startswith(b'gpgsig ') else line[1:])
 else: keep.append(line)
unsigned = b'\\n'.join(keep) + separator + message
body_lines = armor_lines[armor_lines.index(b'') + 1:]
encoded = b''.join(line for line in body_lines if not line.startswith((b'=', b'-----END')))
packet = base64.b64decode(encoded, validate=True)
if packet[0] & 64:
 first = packet[1]
 if first < 192: offset, size = 2, first
 elif first < 224: offset, size = 3, ((first - 192) << 8) + packet[2] + 192
 elif first == 255: offset, size = 6, int.from_bytes(packet[2:6], 'big')
 else: raise ValueError('unexpected partial signature packet')
else:
 width = {0: 1, 1: 2, 2: 4}[packet[0] & 3]
 offset, size = 1 + width, int.from_bytes(packet[1:1 + width], 'big')
assert offset + size == len(packet)
body = packet[offset:]; assert body[0] == 4
unhashed_offset = 6 + int.from_bytes(body[4:6], 'big')
unhashed_size = int.from_bytes(body[unhashed_offset:unhashed_offset + 2], 'big')
unhashed = body[unhashed_offset + 2:unhashed_offset + 2 + unhashed_size]
def length(size):
 if size < 192: return bytes([size])
 if size < 8384: return bytes([((size - 192) >> 8) + 192, (size - 192) & 255])
 return b'\\xff' + size.to_bytes(4, 'big')
def armor(body):
 packet = b'\\xc2' + length(len(body)) + body
 crc = 0xb704ce
 for value in packet:
  crc ^= value << 16
  for _ in range(8):
   crc <<= 1
   if crc & 0x1000000: crc ^= 0x1864cfb
 return ('-----BEGIN PGP SIGNATURE-----\\n\\n' + '\\n'.join(textwrap.wrap(base64.b64encode(packet).decode(), 64))
  + '\\n=' + base64.b64encode((crc & 0xffffff).to_bytes(3, 'big')).decode() + '\\n-----END PGP SIGNATURE-----\\n').encode()
canary = ('gh' + 'p_' + 'A1' * 20).encode(); results = []
for kind, metadata in [(16, b'12345678' + canary), (2, b'\\x65\\x53\\xf1\\x00' + canary), (33, b'\\x04' + b'A' * 20 + canary)]:
 subpacket = bytes([kind]) + metadata
 altered_unhashed = unhashed + length(len(subpacket)) + subpacket
 altered = armor(body[:unhashed_offset] + len(altered_unhashed).to_bytes(2, 'big') + altered_unhashed
  + body[unhashed_offset + 2 + unhashed_size:])
 with tempfile.TemporaryDirectory(prefix='pp-subpacket-signature-') as temporary:
  signature = Path(temporary) / 'signature'; signature.write_bytes(altered)
  verified = subprocess.run(['gpg', '--no-options', '--batch', '--no-tty', '--no-auto-key-retrieve',
   '--status-fd=1', '--verify', str(signature), '-'], input=unsigned, capture_output=True)
 altered_raw = b'\\n'.join(keep) + b'\\ngpgsig ' + altered.rstrip().replace(b'\\n', b'\\n ') + separator + message
 commit = subprocess.check_output(['git', 'hash-object', '-w', '-t', 'commit', '--stdin'], cwd=root,
  input=altered_raw).decode().strip()
 scan = subprocess.run([sys.executable, sys.argv[1], '--root', str(root), '--commit-range', commit,
  '--fail-on-warn'], capture_output=True)
 results.append({'subpacketType': kind, 'gpgExit': verified.returncode,
  'validsig': b'[GNUPG:] VALIDSIG ' in verified.stdout, 'gateExit': scan.returncode})
tag_payload = ('object ' + signed + '\\ntype commit\\ntag v0.5.1\\n'
 'tagger Public Fixture <fixture@example.invalid> 1700000000 +0000\\n\\npublic fixture\\n').encode()
tag_signature = subprocess.check_output(['gpg', '--batch', '--armor', '--detach-sign', '--output', '-'], input=tag_payload)
tag_packet = base64.b64decode(b''.join(line for line in tag_signature.splitlines()[2:]
 if not line.startswith((b'=', b'-----END'))), validate=True)
assert tag_packet[1] < 192 and tag_packet[1] + 2 == len(tag_packet)
tag_body = tag_packet[2:]
tag_unhashed_offset = 6 + int.from_bytes(tag_body[4:6], 'big')
tag_unhashed_size = int.from_bytes(tag_body[tag_unhashed_offset:tag_unhashed_offset + 2], 'big')
tag_unhashed = tag_body[tag_unhashed_offset + 2:tag_unhashed_offset + 2 + tag_unhashed_size]
tag_digest_offset = tag_unhashed_offset + 2 + tag_unhashed_size
assert len(tag_unhashed) == 10 and tag_unhashed[:2] == b'\\x09\\x10'
tag_metadata = {}; cursor = 6
while cursor < tag_unhashed_offset:
 size, kind = tag_body[cursor:cursor + 2]
 tag_metadata[kind] = tag_body[cursor + 2:cursor + 1 + size]; cursor += 1 + size
def tag_area(area):
 return tag_body[:tag_unhashed_offset] + len(area).to_bytes(2, 'big') + area + tag_body[tag_unhashed_offset + 2 + tag_unhashed_size:]
with tempfile.TemporaryDirectory(prefix='pp-tag-privacy-') as temporary:
 temporary = Path(temporary)
 provenance = temporary / 'provenance.json'
 provenance.write_text(json.dumps({'pathset': ['public.txt'], 'pathsetSha256': hashlib.sha256(b'public.txt\\n').hexdigest()}))
 tree = subprocess.check_output(['git', 'rev-parse', signed + '^{tree}'], cwd=root).decode().strip()
 def scan_tag(signature, payload=tag_payload, key_home=None):
  tag = temporary / 'tag.raw'; tag.write_bytes(payload + signature)
  environment = dict(os.environ, PUBLIC_RELEASE_FORBIDDEN_HOSTS='fixture.internal.invalid')
  if key_home is not None: environment['GNUPGHOME'] = str(key_home)
  return subprocess.run([sys.executable, sys.argv[1], '--root', str(root), '--export-tree', tree,
   '--allowlist-pathset', str(provenance), '--tag-envelope-file', str(tag), '--require-forbidden-hosts',
   '--fail-on-warn'], env=environment, capture_output=True).returncode
 canonical_tag_exit = scan_tag(tag_signature)
 empty_home = temporary / 'empty-keyring'; empty_home.mkdir(mode=0o700)
 missing_key_tag_exit = scan_tag(tag_signature, key_home=empty_home)
 tampered_tag_exit = scan_tag(tag_signature, tag_payload.replace(b'public fixture', b'changed fixture'))
 malformed_tag_exit = scan_tag(b'-----BEGIN PGP SIGNATURE-----\\n\\n' + b'A' * 64 + b'\\n-----END PGP SIGNATURE-----\\n')
 for kind, metadata in [(16, b'12345678' + canary), (2, b'\\x65\\x53\\xf1\\x00' + canary), (33, b'\\x04' + b'A' * 20 + canary)]:
  subpacket = bytes([kind]) + metadata
  area = tag_unhashed + length(len(subpacket)) + subpacket
  altered = armor(tag_body[:tag_unhashed_offset] + len(area).to_bytes(2, 'big') + area
   + tag_body[tag_unhashed_offset + 2 + tag_unhashed_size:])
  signature = temporary / 'signature'; signature.write_bytes(altered)
  verified = subprocess.run(['gpg', '--no-options', '--batch', '--no-tty', '--no-auto-key-retrieve',
   '--status-fd=1', '--verify', str(signature), '-'], input=tag_payload, capture_output=True)
  results.append({'subpacketType': 'tag-' + str(kind), 'gpgExit': verified.returncode,
   'validsig': b'[GNUPG:] VALIDSIG ' in verified.stdout, 'gateExit': scan_tag(altered)})
 for name, changed in {
  'duplicate-issuer': tag_area(tag_unhashed + tag_unhashed),
  'wrong-issuer': tag_area(b'\\x09\\x10' + b'12345678'),
  'unhashed-timestamp': tag_area(tag_unhashed + b'\\x05\\x02' + tag_metadata[2]),
  'unhashed-fingerprint': tag_area(tag_unhashed + b'\\x16\\x21' + tag_metadata[33]),
  'overlong-issuer-replacement': tag_area(bytes([9 + len(canary), 16]) + tag_unhashed[2:] + canary),
  'alternate-length-issuer': tag_area(b'\\xff' + (9).to_bytes(4, 'big') + tag_unhashed[1:]),
  'unknown-metadata': tag_area(tag_unhashed + bytes([1 + len(canary), 127]) + canary),
  'signature-mpi-tail': tag_body + canary,
  'digest-prefix-changed': tag_body[:tag_digest_offset] + bytes([tag_body[tag_digest_offset] ^ 1]) + tag_body[tag_digest_offset + 1:],
 }.items():
  altered = armor(changed); signature = temporary / 'signature'; signature.write_bytes(altered)
  verified = subprocess.run(['gpg', '--no-options', '--batch', '--no-tty', '--no-auto-key-retrieve',
   '--status-fd=1', '--verify', str(signature), '-'], input=tag_payload, capture_output=True)
  results.append({'subpacketType': 'tag-' + name, 'gpgExit': verified.returncode,
   'validsig': b'[GNUPG:] VALIDSIG ' in verified.stdout, 'gateExit': scan_tag(altered)})
print(json.dumps({'cases': results, 'canonicalTagExit': canonical_tag_exit, 'missingKeyTagExit': missing_key_tag_exit,
 'tamperedTagExit': tampered_tag_exit, 'malformedTagExit': malformed_tag_exit}))
`, gate, root, signed], { encoding: 'utf8', env });
        expect(subpacketProbe.status, `${subpacketProbe.stdout}${subpacketProbe.stderr}`).toBe(0);
        const tagChecks = JSON.parse(subpacketProbe.stdout);
        expect(tagChecks.canonicalTagExit).toBe(0);
        expect(tagChecks.missingKeyTagExit).toBe(1);
        expect(tagChecks.tamperedTagExit).toBe(1);
        expect(tagChecks.malformedTagExit).toBe(1);
        for (const result of tagChecks.cases) {
          expect(result.gpgExit, `subpacket ${result.subpacketType} crypto`).toBe(0);
          expect(result.validsig, `subpacket ${result.subpacketType} crypto`).toBe(true);
          expect(result.gateExit, `subpacket ${result.subpacketType} privacy`).toBe(1);
        }
        const notation = `fixture@example.invalid=ghp_${'A1'.repeat(20)}`;
        const signature = execFileSync('gpg', ['--batch', '--armor', '--detach-sign', '--output', '-',
          '--sig-notation', notation], { env, input: unsigned, stdio: ['pipe', 'pipe', 'pipe'] });
        const notatedHeader = signature.toString().trimEnd().split('\n').join('\n ');
        const notated = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
          cwd: root, input: Buffer.concat([
            Buffer.from(`${unsignedHeaders.join('\n')}\ngpgsig ${notatedHeader}\n\n`), message,
          ]), encoding: 'utf8',
        }).trim();
        expect(scan(notated).status).toBe(1);
        const tampered = execFileSync('git', ['hash-object', '-w', '-t', 'commit', '--stdin'], {
          cwd: root, input: Buffer.from(raw.toString().replace('signed public fixture', 'changed public fixture')),
          encoding: 'utf8',
        }).trim();
        expect(scan(tampered).status).toBe(1);
      } finally {
        spawnSync('gpgconf', ['--homedir', keyring, '--kill', 'gpg-agent'], { stdio: 'ignore' });
        rmSync(root, { recursive: true, force: true });
        rmSync(keyring, { recursive: true, force: true });
        rmSync(emptyKeyring, { recursive: true, force: true });
      }
    },
  );

  it('limits reviewed historical findings to exact original commits while allowing future clean publication ancestry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'punchpilot-privacy-history-'));
    try {
      git(root, 'init', '--quiet');
      git(root, 'config', 'user.name', 'Public Fixture');
      git(root, 'config', 'user.email', 'fixture@example.invalid');
      git(root, 'config', 'commit.gpgsign', 'false');
      git(root, 'config', 'tag.gpgsign', 'false');
      const fixture = `const ${['refresh', 'Token'].join('')} = '${['refresh', 'token', 'abc123xyz'].join('_')}';\n`;
      writeFileSync(path.join(root, 'fixture.mjs'), fixture);
      writeFileSync(path.join(root, 'public.txt'), 'public fixture\n');
      git(root, 'add', '--all');
      git(root, 'commit', '--quiet', '-m', 'test: reviewed historical fixture');
      const base = git(root, 'rev-parse', 'HEAD');
      git(root, 'rm', '--quiet', 'fixture.mjs');
      git(root, 'commit', '--quiet', '-m', 'test: clean publication');
      const publication = git(root, 'rev-parse', 'HEAD');
      git(root, 'commit', '--quiet', '--allow-empty', '-m', 'test: following publication');
      const following = git(root, 'rev-parse', 'HEAD');
      writeFileSync(path.join(root, 'fixture.mjs'), fixture);
      git(root, 'add', '--all');
      git(root, 'commit', '--quiet', '-m', 'test: reintroduce same historical bytes');
      const reintroduced = git(root, 'rev-parse', 'HEAD');
      const script = `
import argparse, copy, hashlib, importlib.util, json, os, subprocess, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('fixture_gate', sys.argv[1])
gate = importlib.util.module_from_spec(spec); sys.modules[spec.name] = gate; spec.loader.exec_module(gate)
root = Path(sys.argv[2]); base, publication, following, reintroduced = sys.argv[3:]
def git(*args): return subprocess.check_output(['git', *args], cwd=root)
def sha(data): return hashlib.sha256(data).hexdigest()
data = git('show', base + ':fixture.mjs')
policy = {'git_commit': base, 'commits': [{'git_commit': base, 'sha256': sha(git('cat-file', 'commit', base))}],
 'materials': [{'surface': 'blob', 'git_commit': None, 'path': 'fixture.mjs', 'sha256': sha(data),
 'lines': [{'line': 1, 'sha256': sha(data.splitlines()[0]), 'label': 'generic assigned secret'}]}]}
rules = list(gate.BASE_RULES)
def scan(commit, reviewed):
 gate.REVIEWED_PUBLIC_HISTORY = reviewed
 findings = []; gate.scan_commit_range(root, commit, rules, findings, expected_ref=commit)
 return [finding.label for finding in findings]
result = {'base': scan(base, policy), 'publication': scan(publication, policy),
 'following': scan(following, policy), 'reintroduced': scan(reintroduced, policy)}
drift = copy.deepcopy(policy); drift['commits'][0]['sha256'] = '0' * 64
result['commit_drift'] = scan(base, drift)
drift = copy.deepcopy(policy); drift['materials'][0]['lines'][0]['sha256'] = '0' * 64
result['line_drift'] = scan(base, drift)
drift = copy.deepcopy(policy); drift['materials'][0]['path'] = 'different.mjs'
result['path_drift'] = scan(base, drift)
drift = copy.deepcopy(policy); drift['materials'] = []
result['missing_material'] = scan(base, drift)
drift = copy.deepcopy(policy); drift['materials'][0]['lines'][0]['label'] = 'unclassified high-entropy credential'
result['label_drift'] = scan(base, drift)
gate.REVIEWED_PUBLIC_HISTORY = policy
findings = []; gate.scan_tree_objects(root, reintroduced, rules, findings)
result['new_export_tree'] = [finding.label for finding in findings]
new_source = git('commit-tree', git('rev-parse', base + '^{tree}').decode().strip(), '-m', 'test: independent source').decode().strip()
result['new_source'] = scan(new_source, policy)
hard_cases = {
 'private 10.x IP': '.'.join(['10', '77', '66', '55']),
 'macOS home path': '/Users/' + 'private-fixture/project',
 'GitHub token': 'ghp_' + 'A1' * 20,
 'HTTP credential': 'Authorization: Bearer ' + 'synthetic-credential-material-12345',
 'forbidden internal hostname': 'private.' + 'example.invalid',
}
rules += gate.forbidden_host_rules('private.' + 'example.invalid')
for label, value in hard_cases.items():
 dangerous = (value + '\\n').encode()
 blob = subprocess.check_output(['git', 'hash-object', '-w', '--stdin'], cwd=root, input=dangerous).decode().strip()
 tree = subprocess.check_output(['git', 'mktree'], cwd=root, input=('100644 blob ' + blob + '\\tfixture.mjs\\n').encode()).decode().strip()
 commit = git('commit-tree', tree, '-m', 'test: deliberately invalid review claim').decode().strip()
 forged = {'git_commit': commit, 'commits': [{'git_commit': commit, 'sha256': sha(git('cat-file', 'commit', commit))}],
  'materials': [{'surface': 'blob', 'git_commit': None, 'path': 'fixture.mjs', 'sha256': sha(dangerous),
  'lines': [{'line': 1, 'sha256': sha(dangerous.splitlines()[0]), 'label': label}]}]}
 result[label] = scan(commit, forged)
image = (Path(sys.argv[1]).parents[2] / 'client/public/favicon-16x16.png').read_bytes()
blob = subprocess.check_output(['git', 'hash-object', '-w', '--stdin'], cwd=root, input=image).decode().strip()
tree = subprocess.check_output(['git', 'mktree'], cwd=root, input=('100644 blob ' + blob + '\\thistorical.png\\n').encode()).decode().strip()
image_base = git('commit-tree', tree, '-m', 'test: reviewed historical image').decode().strip()
image_next = git('commit-tree', tree, '-p', image_base, '-m', 'test: unreviewed image reintroduction').decode().strip()
image_policy = {'git_commit': image_base, 'commits': [{'git_commit': image_base, 'sha256': sha(git('cat-file', 'commit', image_base))}],
 'materials': [{'surface': 'binary', 'git_commit': None, 'path': 'historical.png', 'sha256': sha(image), 'bytes': len(image), 'lines': []}]}
result['binary_history'] = scan(image_base, image_policy)
result['binary_new'] = scan(image_next, image_policy)
print(json.dumps(result))
`;
      const result = spawnSync('/usr/bin/python3', ['-c', script, gate, root, base, publication, following, reintroduced], {
        encoding: 'utf8',
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const checks = JSON.parse(result.stdout);
      for (const name of ['base', 'publication', 'following', 'binary_history']) expect(checks[name], name).toEqual([]);
      for (const name of ['reintroduced', 'commit_drift', 'line_drift', 'path_drift', 'missing_material', 'label_drift', 'new_export_tree', 'new_source']) {
        expect(checks[name], name).toContainEqual(expect.stringContaining('generic assigned secret'));
      }
      expect(checks.binary_new).toContainEqual(expect.stringContaining('unreviewed binary artifact'));
      for (const name of ['private 10.x IP', 'macOS home path', 'GitHub token', 'HTTP credential', 'forbidden internal hostname']) {
        expect(checks[name], name).toContainEqual(expect.stringContaining(name));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
