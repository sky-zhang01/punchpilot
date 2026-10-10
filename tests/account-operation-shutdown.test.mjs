import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const accountOperationUrl = new URL('../server/account-operation.js', import.meta.url).href;

describe('account operation shutdown barrier', () => {
  it('lets the active operation finish while rejecting queued and future work', async () => {
    const script = `
      const {
        acquireAccountOperation,
        beginAccountOperationShutdown,
        releaseAccountOperation,
        waitForAccountOperationsIdle,
      } = await import(${JSON.stringify(accountOperationUrl)});

      await acquireAccountOperation();
      const queued = acquireAccountOperation().then(
        () => 'unexpected-acquire',
        (error) => error.code,
      );
      beginAccountOperationShutdown();
      const future = acquireAccountOperation().then(
        () => 'unexpected-acquire',
        (error) => error.code,
      );
      const queuedResult = await queued;
      const futureResult = await future;
      releaseAccountOperation();
      const idle = await waitForAccountOperationsIdle(100);
      process.stdout.write(JSON.stringify({ queuedResult, futureResult, idle }));
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { timeout: 5_000 },
    );

    expect(JSON.parse(stdout)).toEqual({
      queuedResult: 'ACCOUNT_OPERATION_SHUTTING_DOWN',
      futureResult: 'ACCOUNT_OPERATION_SHUTTING_DOWN',
      idle: true,
    });
  });
});
