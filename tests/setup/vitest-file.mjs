import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const loopbackAddress = Symbol.for('punchpilot.supertest.loopback-address');
const originalServerAddress = request.Test.prototype.serverAddress;
if (!originalServerAddress[loopbackAddress]) {
  const serverAddress = function (app, route) {
    const url = originalServerAddress.call(this, app, route);
    // An IPv4 listener can own the same port as this IPv6 server on macOS.
    // Keep Supertest's lifecycle and target its actual address family.
    return app.address()?.address === '::'
      ? url.replace(/^(https?:\/\/)127\.0\.0\.1:/, '$1[::1]:')
      : url;
  };
  Object.defineProperty(serverAddress, loopbackAddress, { value: true });
  request.Test.prototype.serverAddress = serverAddress;
}

const runRoot = process.env.PUNCHPILOT_TEST_RUN_ROOT;
const expectedParent = fs.realpathSync(os.tmpdir());
if (
  typeof runRoot !== 'string' ||
  fs.realpathSync(path.dirname(runRoot)) !== expectedParent ||
  !/^punchpilot-vitest-\d+-[a-f0-9-]+$/.test(path.basename(runRoot))
) {
  throw new Error('Vitest database root is outside the approved temporary directory');
}

const fileRoot = path.join(runRoot, `file-${crypto.randomUUID()}`);
process.env.PUNCHPILOT_DB_PATH = path.join(fileRoot, 'data', 'punchpilot.db');
process.env.PUNCHPILOT_KEYSTORE_DIR = path.join(fileRoot, 'keystore');
process.env.PUNCHPILOT_LEGACY_APP_SECRET_FILE = path.join(
  fileRoot,
  'data',
  '.app-secret',
);
