import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup(project) {
  const runRoot = project.config.env?.PUNCHPILOT_TEST_RUN_ROOT;
  if (typeof runRoot !== 'string') {
    throw new Error('Vitest database root is not configured');
  }

  const expectedParent = fs.realpathSync(os.tmpdir());
  const actualParent = fs.realpathSync(path.dirname(runRoot));
  if (
    actualParent !== expectedParent ||
    !/^punchpilot-vitest-\d+-[a-f0-9-]+$/.test(path.basename(runRoot))
  ) {
    throw new Error('Vitest database path is outside the approved temporary directory');
  }

  fs.rmSync(runRoot, { recursive: true, force: true });
  return () => fs.rmSync(runRoot, { recursive: true, force: true });
}
