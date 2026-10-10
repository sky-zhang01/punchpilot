import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from './api';

const response = (value: unknown) => new Response(JSON.stringify(value));

describe('API method contracts', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => response({}))));
  afterEach(() => vi.unstubAllGlobals());

  it('sends the account identity through the protected credentialed transport', async () => {
    await api.saveAccount('test-user', 'example-password', 'Example Company');
    expect(fetch).toHaveBeenCalledWith('/api/config/account', expect.objectContaining({
      credentials: 'include', method: 'PUT',
      headers: expect.objectContaining({ 'X-PunchPilot-Request': '1' }),
      body: JSON.stringify({ username: 'test-user', password: 'example-password', company_name: 'Example Company' }),
    }));
  });

  it('uses the server password-change contract', async () => {
    await api.changePassword({ old_password: 'CurrentPass123', new_password: 'ReplacementPass456' });
    expect(fetch).toHaveBeenCalledWith('/api/auth/password', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ old_password: 'CurrentPass123', new_password: 'ReplacementPass456' }),
    }));
  });

  it('starts OAuth authorization as a bodyless protected write', async () => {
    await api.getOAuthAuthorizeUrl();
    expect(fetch).toHaveBeenCalledWith('/api/config/oauth-authorize-url', expect.objectContaining({ method: 'POST' }));
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBeUndefined();
  });

  it('invalidates reads started during an identity mutation even when its response is lost', async () => {
    let rejectMutation!: (error: Error) => void;
    let resolveRead!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((_, reject) => { rejectMutation = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const mutation = expect(api.saveAccount('new-user', 'example-password', 'Company')).rejects.toThrow('offline');
    const pendingRead = expect(api.getStatus()).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    rejectMutation(new TypeError('offline'));
    await mutation;
    resolveRead(response({ employee: 'previous' }));
    await pendingRead;
  });
  it('stops polling interrupted mutations and keeps reconciliation evidence', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ task_id: 'interrupted-task' }))
      .mockResolvedValueOnce(response({ taskId: 'interrupted-task', taskType: 'batch_punch', status: 'interrupted', createdAt: null, completedAt: null, success: false, processed: 0, succeeded: 0, failed: 0, unknown: 0, strategy_info: null, error: null, results: [], total: null, partial: true, code: 'TASK_RESULT_UNAVAILABLE' }));
    await expect(api.submitBatch({ entries: [{ date: '2026-07-11' }] })).rejects.toMatchObject({
      code: 'TASK_RESULT_UNAVAILABLE', taskId: 'interrupted-task', task: { status: 'interrupted', total: null },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
