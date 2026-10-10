import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asyncBatchRequest, clearTaskReferences, getTask, getTaskReferences, getTaskSnapshots, pollTask, resumeTask, type TaskDTO } from './tasks';

import { invalidateIdentity } from './http';

const task = (overrides: Partial<TaskDTO> = {}): TaskDTO => ({ taskId: 'task-1', taskType: 'batch_punch', status: 'running', createdAt: '2026-10-04T00:00:00Z', completedAt: null, success: false, partial: true, total: 3, processed: 1, succeeded: 1, failed: 0, unknown: 0, results: [{ date: '2026-10-01', success: true }], strategy_info: null, error: null, code: null, ...overrides });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('durable batch task client', () => {
  beforeEach(() => { clearTaskReferences(); vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('discards stored references with unsupported or coerced task types', () => {
    sessionStorage.setItem('punchpilot.tasks', JSON.stringify([
      { taskId: 'valid', taskType: 'batch_punch' },
      { taskId: 'unknown', taskType: 'batch' },
      { taskId: 'array', taskType: ['batch_punch'] },
      { taskId: 'object', taskType: { toString: 'batch_punch' } },
      { taskId: 'boolean', taskType: true },
    ]));
    expect(getTaskReferences()).toEqual([{ taskId: 'valid', taskType: 'batch_punch' }]);
  });
  it('retains partial failed results and task id instead of flattening the error', async () => {
    const failed = task({ status: 'failed', error: 'checkpoint failed', code: 'TASK_PERSISTENCE_FAILED' });
    vi.mocked(fetch).mockResolvedValueOnce(response({ task_id: 'task-1' })).mockResolvedValueOnce(response(failed));
    await expect(asyncBatchRequest('/attendance/batch', {}, 'batch_punch')).rejects.toMatchObject({ taskId: 'task-1', task: failed });
    expect(getTaskReferences()).toEqual([{ taskId: 'task-1', taskType: 'batch_punch' }]);
    expect(JSON.stringify(sessionStorage)).not.toContain('checkpoint failed');
  });
  it('keeps the last checkpoint on network loss, then resumes exclusively through GET', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(response(task())).mockRejectedValueOnce(new TypeError('offline'));
    const pending = expect(pollTask('task-1', { intervalMs: 1, maxMs: 100 })).rejects.toMatchObject({ taskId: 'task-1', task: { processed: 1, results: [{ success: true }] } });
    await vi.advanceTimersByTimeAsync(2); await pending;
    vi.mocked(fetch).mockResolvedValueOnce(response(task({ status: 'completed', total: 1, partial: false, success: true })));
    const result = await resumeTask('task-1');
    expect(result.data.processed).toBe(1);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });
  it('a polling timeout preserves running evidence and never labels unprocessed items failed', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async () => response(task()));
    const pending = expect(pollTask('task-1', { intervalMs: 2, maxMs: 3 })).rejects.toMatchObject({ code: 'TASK_POLL_TIMEOUT', taskId: 'task-1', task: { status: 'running', processed: 1, failed: 0 } });
    await vi.advanceTimersByTimeAsync(5); await pending;
  });
  it.each([
    task({ taskId: 'wrong-task' }),
    task({ taskType: 'batch' as never }),
    task({ taskType: ['batch_punch'] as never }),
    task({ status: 'paused' as never }),
    task({ status: true as never }),
    task({ results: null as never }),
    task({ processed: 4 }),
    task({ results: [{ success: false, error: {} as never }] }),
    task({ status: 'completed', success: true, unknown: 1 }),
  ])('rejects malformed successful task responses without overwriting evidence', async (invalid) => {
    vi.mocked(fetch).mockResolvedValue(response(invalid));
    await expect(getTask('task-1')).rejects.toMatchObject({ code: 'TASK_RESPONSE_INVALID' });
  });
  it('bounds a hanging task response by the remaining polling budget', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(response(task())).mockImplementationOnce(async (_url, init) => ({
      ok: true, status: 200,
      text: () => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    }) as Response);
    const pending = expect(pollTask('task-1', { intervalMs: 1, maxMs: 20 })).rejects.toMatchObject({ code: 'TASK_POLL_TIMEOUT', task: { processed: 1 } });
    await vi.advanceTimersByTimeAsync(21); await pending;
  });
  it('does not refill the task cache when identity changes between transport and task continuations', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(task()))
      .then(text => { queueMicrotask(() => queueMicrotask(() => invalidateIdentity())); return text; }) } as Response);
    await expect(getTask('task-1')).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(getTaskSnapshots()).toEqual([]);
  });
  it.each(['network', 'missing-id', 'gateway'])('marks ambiguous admission %s without inventing a task id', async (scenario) => {
    if (scenario === 'network') vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
    else vi.mocked(fetch).mockResolvedValue(response({}, scenario === 'gateway' ? 502 : 200));
    await expect(asyncBatchRequest('/attendance/batch', {}, 'batch_punch')).rejects.toMatchObject({ code: 'TASK_ADMISSION_UNKNOWN' });
    expect(getTaskReferences()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([400, 503])('keeps explicit pre-admission rejection %s available for correction', async status => {
    vi.mocked(fetch).mockResolvedValue(response({ code: status === 503 ? 'TASK_PERSISTENCE_FAILED' : 'INVALID_DATE' }, status));
    await expect(asyncBatchRequest('/attendance/batch', {}, 'batch_punch')).rejects.toMatchObject({ code: status === 503 ? 'TASK_PERSISTENCE_FAILED' : 'INVALID_DATE' });
    expect(getTaskReferences()).toEqual([]);
  });
  it('keeps historical total unknown and stops on interrupted outcomes', async () => {
    const historical = task({ status: 'interrupted', total: null, processed: 0, succeeded: 0, results: [], code: 'TASK_RESULT_UNAVAILABLE' });
    vi.mocked(fetch).mockResolvedValue(response(historical));
    await expect(resumeTask('task-1')).rejects.toMatchObject({ task: { total: null, partial: true, results: [] } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
