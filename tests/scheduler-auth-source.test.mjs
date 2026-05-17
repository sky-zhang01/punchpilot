/**
 * Source-level guardrails for auth failure scheduling.
 * These complement API tests by pinning the incident-specific control flow.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('scheduler auth failure guardrails', () => {
  const schedulerSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'scheduler.js'), 'utf8');
  const publicApiSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'server', 'automation', 'public-api.js'), 'utf8');

  it('keeps auth failure code visible to scheduler decisions', () => {
    expect(publicApiSrc).toContain('errorCode: error.code || null');
    expect(schedulerSrc).toContain("resultErrorCode(result) === FREEE_AUTH_ERROR_CODES.AUTH_REQUIRED");
    expect(schedulerSrc).toContain("resultErrorCode(result) === FREEE_AUTH_ERROR_CODES.AUTH_TRANSIENT");
  });

  it('does not mark failed scheduled actions as executed unconditionally', () => {
    expect(schedulerSrc).toContain("markDailyScheduleExecuted(today, actionType, 'success'");
    expect(schedulerSrc).toContain("updateDailyScheduleStatus(today, actionType, 'failure'");
    expect(schedulerSrc).not.toContain('markDailyScheduleExecuted(today, actionType);\n');
  });

  it('records the smart-schedule unknown fall-through as an execution log', () => {
    expect(schedulerSrc).toContain('recordSmartScheduleSkip(plan)');
    expect(schedulerSrc).toContain("action_type: 'daily_resolution'");
    expect(schedulerSrc).toContain("trigger_type: 'scheduler'");
  });

  it('skips the unknown-state retry loop when OAuth is already known broken', () => {
    expect(schedulerSrc).toContain("getConnectionMode() === 'api' && isOAuthAuthBroken()");
    expect(schedulerSrc).toContain('currentState === FREEE_STATE.UNKNOWN && isApiOAuthAuthBroken()');
    expect(schedulerSrc).toContain("OAuth authorization requires re-authorization; skipping retry loop");
  });
});
