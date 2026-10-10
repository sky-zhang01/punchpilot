#!/usr/bin/env node
// Safe local rehearsal of the installed production publisher and its gates.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readConsumerSnapshot } from './isolated-publisher.mjs';

try {
  const values = new Map();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!['--snapshot', '--state'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || values.has(args[index])) throw new Error('unsupported or incomplete boundary-dryrun argument');
    values.set(args[index], args[index + 1]);
  }
  const snapshotDir = values.get('--snapshot'), stateDir = values.get('--state');
  if (!snapshotDir || !stateDir) throw new Error('--snapshot and --state are required');
  const snapshot = readConsumerSnapshot(snapshotDir);
  if (!path.isAbsolute(snapshot.publicUrl)) throw new Error('boundary dry-run requires a local bare fixture');
  const result = spawnSync(process.execPath, [path.join(snapshotDir, 'isolated-publisher.mjs'), 'rehearse', '--snapshot', snapshotDir, '--state', stateDir], { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error('installed publisher rehearsal failed');
  console.log('OK - installed publisher boundary rehearsal passed.');
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
