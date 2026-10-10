import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const entry = new URL('../scripts/ci/publication-boundary-dryrun.mjs', import.meta.url);
describe('installed publisher rehearsal boundary', () => {
  it('requires a private installed snapshot and durable state', () => {
    const result = spawnSync(process.execPath, [entry.pathname], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--snapshot and --state are required');
  });
  it.each(['--refspec', '--publication-commit', '--bare-remote', '--force'])('rejects arbitrary source/object/ref overrides %s', (option) => {
    const result = spawnSync(process.execPath, [entry.pathname, option, 'unsafe'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported');
  });
});
