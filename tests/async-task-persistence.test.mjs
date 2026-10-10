import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  initDatabase, getDb, setSetting, currentExecutionLogIdentityKey, cleanOldAsyncTasks,
} from '../server/db.js';
import {
  createTask, beginTaskItem, clearTaskItem, checkpointTaskResult, updateTask, getTask,
  trackTaskPromise, waitForAsyncTasksIdle,
} from '../server/async-tasks.js';

let identity;
beforeEach(() => {
  initDatabase();
  getDb().prepare('DELETE FROM async_tasks').run();
  getDb().prepare('DELETE FROM execution_log').run();
  setSetting('connection_mode', 'api');
  setSetting('oauth_company_id', '12');
  setSetting('oauth_employee_id', '34');
  identity = { identityKey: currentExecutionLogIdentityKey(), companyId: '12', companyName: 'Synthetic' };
});
afterEach(() => { vi.useRealTimers(); });

describe('durable task lifecycle', () => {
  it.each(['batch', 'Batch_Punch', '__proto__', true, [], {}, null, undefined])(
    'rejects unsupported task type %j before persisting admission', taskType => {
      expect(() => createTask(taskType, identity, 1)).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
      expect(getDb().prepare('SELECT count(*) AS n FROM async_tasks').get().n).toBe(0);
    },
  );

  it.each(['done', 'RUNNING', 'paused', true, [], {}, null])(
    'rejects unsupported task status %j without changing saved progress', status => {
      const task = createTask('batch_punch', identity, 1);
      const original = getTask(task.id);
      expect(() => updateTask(task, { status })).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
      expect(getTask(task.id)).toEqual(original);
    },
  );

  it('persists complete progress and terminal DTO without a result cache', () => {
    const task = createTask('batch_punch', identity, 2);
    expect(getTask(task.id)).toMatchObject({ taskId: task.id, status: 'running', total: 2, results: [], completedAt: null });
    beginTaskItem(task, { date: '2026-10-01' });
    checkpointTaskResult(task, { date: '2026-10-01', success: true, method: 'direct' });
    const progress = getTask(task.id);
    expect(progress).toMatchObject({ processed: 1, succeeded: 1, failed: 0, unknown: 0, partial: true });
    expect(JSON.parse(getDb().prepare('SELECT result_json FROM async_tasks WHERE id=?').get(task.id).result_json).results).toEqual(progress.results);
    checkpointTaskResult(task, { date: '2026-10-02', success: false, unknown: true, error: 'mutation_outcome_unconfirmed' });
    updateTask(task, { status: 'completed', strategy_info: { direct_disabled: false } });
    const final = getTask(task.id);
    expect(final).toMatchObject({ taskType: 'batch_punch', status: 'completed', success: false, partial: false, processed: 2, succeeded: 1, failed: 0, unknown: 1, strategy_info: { direct_disabled: false } });
    expect(final.createdAt).toMatch(/Z$/);
    expect(final.completedAt).toMatch(/Z$/);
    initDatabase();
    expect(getTask(task.id)).toEqual(final);
    expect(getTask(task.id, `log-v1:${'a'.repeat(64)}`)).toBeNull();
    expect(final).not.toHaveProperty('identity');
  });

  it('recovers only the in-flight item as unknown and never replays it', () => {
    const task = createTask('batch_leave', identity, 3);
    checkpointTaskResult(task, { date: '2026-10-01', success: true });
    beginTaskItem(task, { date: '2026-10-02', type: 'PaidHoliday' });
    initDatabase();
    const recovered = getTask(task.id);
    expect(recovered).toMatchObject({ status: 'interrupted', partial: true, total: 3, processed: 2, succeeded: 1, failed: 0, unknown: 1 });
    expect(recovered.results[1]).toMatchObject({ date: '2026-10-02', success: false, unknown: true });
    initDatabase();
    expect(getTask(task.id)).toEqual(recovered);
    expect(() => beginTaskItem(task, { date: '2026-10-03' })).toThrow();
  });

  it('rejects admission on persistence failure', () => {
    getDb().exec("CREATE TEMP TRIGGER reject_task BEFORE INSERT ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic admission'); END");
    try {
      expect(() => createTask('batch_punch', identity, 1)).toThrow();
      expect(getDb().prepare('SELECT count(*) AS n FROM async_tasks').get().n).toBe(0);
    } finally { getDb().exec('DROP TRIGGER reject_task'); }
  });

  it('atomically checkpoints the log and result; a failure preserves the active marker', () => {
    const task = createTask('batch_punch', identity, 2);
    beginTaskItem(task, { date: '2026-10-01' });
    getDb().exec("CREATE TEMP TRIGGER reject_result BEFORE UPDATE OF result_json ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic checkpoint'); END");
    try {
      expect(() => checkpointTaskResult(task, { date: '2026-10-01', success: true }, { action_type: 'batch_correction', status: 'success' })).toThrow();
      expect(getDb().prepare('SELECT count(*) AS n FROM execution_log').get().n).toBe(0);
      expect(getTask(task.id).results).toEqual([]);
    } finally { getDb().exec('DROP TRIGGER reject_result'); }
    updateTask(task, { status: 'failed', code: 'TASK_PERSISTENCE_FAILED', error: 'Task checkpoint could not be saved.' });
    expect(getTask(task.id)).toMatchObject({ status: 'failed', processed: 1, unknown: 1, succeeded: 0, failed: 0, partial: true });
  });

  it('recovers a stopped worker after a transient terminal write failure', async () => {
    const task = createTask('batch_approve', identity, 1);
    beginTaskItem(task, { id: 7, type: 'WorkTime', action: 'approve' });
    getDb().exec("CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE ON async_tasks BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END");
    await trackTaskPromise(task, Promise.reject(new Error('synthetic task error')));
    await expect(waitForAsyncTasksIdle(100)).resolves.toBe(true);
    getDb().exec('DROP TRIGGER reject_terminal');
    expect(getTask(task.id)).toMatchObject({ status: 'interrupted', unknown: 1, success: false });
  });

  it('never expires running tasks and counts terminal retention from completion', () => {
    const running = createTask('batch_punch', identity, 1);
    const recent = createTask('batch_punch', identity, 1);
    const expired = createTask('batch_punch', identity, 1);
    getDb().prepare("UPDATE async_tasks SET created_at='2001-01-01T00:00:00.000Z'").run();
    checkpointTaskResult(recent, { date: '2026-10-01', success: true });
    updateTask(recent, { status: 'completed' });
    checkpointTaskResult(expired, { date: '2026-10-02', success: true });
    updateTask(expired, { status: 'completed' });
    getDb().prepare("UPDATE async_tasks SET completed_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(expired.id);
    cleanOldAsyncTasks(2);
    expect(getTask(running.id).status).toBe('running');
    expect(getTask(recent.id).status).toBe('completed');
    expect(getTask(expired.id)).toBeNull();
  });

  it('reports unavailable historical results without inventing a zero-size success', () => {
    getDb().prepare("INSERT INTO async_tasks (id,task_type,identity_key,status,created_at) VALUES (?,?,?,'completed','2026-01-01 12:00:00')").run('historical', 'batch_punch', identity.identityKey);
    expect(getTask('historical')).toMatchObject({ status: 'interrupted', total: null, createdAt: null, partial: true, success: false, results: [], code: 'TASK_RESULT_UNAVAILABLE' });
  });

  it('does not double-count or duplicate the audit log for an already checkpointed item', () => {
    const task = createTask('batch_punch', identity, 1);
    const result = { date: '2026-10-01', success: true, method: 'direct' };
    const log = { action_type: 'batch_correction', status: 'success' };
    checkpointTaskResult(task, result, log);
    checkpointTaskResult(task, result, log);
    expect(getTask(task.id)).toMatchObject({ total: 1, processed: 1, results: [result] });
    expect(getDb().prepare('SELECT count(*) AS n FROM execution_log').get().n).toBe(1);
  });

  it('keeps a confirmed rejection out of unknown outcomes when its fallback has not started', () => {
    const task = createTask('batch_punch', identity, 2);
    beginTaskItem(task, { date: '2026-10-01' });
    clearTaskItem(task);
    initDatabase();
    expect(getTask(task.id)).toMatchObject({ status: 'interrupted', processed: 0, unknown: 0, results: [], partial: true });
  });

  it('rejects premature completion, conflicting results, and a different identity without changing progress', () => {
    const task = createTask('batch_punch', identity, 1);
    beginTaskItem(task, { date: '2026-10-01' });
    const original = getTask(task.id);
    expect(() => updateTask(task, { status: 'completed' })).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
    expect(() => checkpointTaskResult(task, { date: '2026-10-02', success: true })).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
    expect(() => checkpointTaskResult(task, { date: '2026-10-01', success: true, unknown: true })).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
    const foreignHandle = { id: task.id, identity: { identityKey: `log-v1:${'f'.repeat(64)}` } };
    expect(() => checkpointTaskResult(foreignHandle, { date: '2026-10-01', success: true })).toThrowError(expect.objectContaining({ code: 'TASK_STATE_INVALID' }));
    expect(getTask(task.id)).toEqual(original);
  });

  it('reports corrupt saved results as a persistence failure rather than a missing task', () => {
    const task = createTask('batch_punch', identity, 1);
    for (const invalid of ['{', '{"total":0,"results":[]}']) {
      getDb().prepare('UPDATE async_tasks SET result_json=? WHERE id=?').run(invalid, task.id);
      expect(() => getTask(task.id)).toThrowError(expect.objectContaining({ code: 'TASK_PERSISTENCE_FAILED' }));
    }
  });

  it('times out an idle wait without cancelling the worker and resolves concurrent waits on completion', async () => {
    vi.useFakeTimers();
    const task = createTask('batch_punch', identity, 1);
    let finish;
    const tracked = trackTaskPromise(task, new Promise(resolve => { finish = resolve; }));
    const timed = waitForAsyncTasksIdle(10);
    const untimed = waitForAsyncTasksIdle(0);
    await vi.advanceTimersByTimeAsync(10);
    await expect(timed).resolves.toBe(false);
    expect(getTask(task.id).status).toBe('running');
    checkpointTaskResult(task, { date: '2026-10-01', success: true });
    updateTask(task, { status: 'completed' });
    finish();
    await tracked;
    await expect(untimed).resolves.toBe(true);
    await expect(waitForAsyncTasksIdle()).resolves.toBe(true);
  });
});
