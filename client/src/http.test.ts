import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { invalidateIdentity } from './http';

describe('native API transport', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('preserves cookies, mutation marker, JSON and primitive query values', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}'));
    await http.put('/config/checkin', { enabled: false }, { params: { q: '東京 +', zero: 0, no: false, omit: null } });
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/config/checkin?q=%E6%9D%B1%E4%BA%AC+%2B&zero=0&no=false');
    expect(options).toMatchObject({ credentials: 'include', method: 'PUT', body: '{"enabled":false}', headers: { 'X-PunchPilot-Request': '1', 'Content-Type': 'application/json' } });
  });
  it('retains server error bodies and does not retry mutations', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"error":"invalid","code":"INVALID"}', { status: 422 }));
    await expect(http.post('/attendance/batch', {})).rejects.toMatchObject({ response: { status: 422, data: { error: 'invalid', code: 'INVALID' } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('allows a default request to complete after 60 seconds, matching the previous transport', async () => {
    vi.useFakeTimers();
    let finish!: (body: string) => void;
    vi.mocked(fetch).mockImplementation(async (_url, init) => ({ ok: true, status: 200, text: () => new Promise((resolve, reject) => {
      finish = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }) }) as Response);
    let settled = false;
    const pending = http.get('/status').then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false);
    finish('{"ok":true}');
    await expect(pending).resolves.toMatchObject({ data: { ok: true }, status: 200 });
  });
  it('keeps an explicit timeout active while the response body is arriving', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async (_url, init) => ({ ok: true, status: 200, text: () => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }) as Response);
    const pending = expect(http.get('/status', { timeout: 60_000 })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    await vi.advanceTimersByTimeAsync(60_001);
    await pending;
  });
  it('rejects non-primitive query values before sending a request', async () => {
    await expect(http.get('/logs', { params: { q: {} as never } })).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an old identity response after account invalidation', async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = expect(http.get('/status')).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    invalidateIdentity();
    resolve(new Response('{"account":"old"}'));
    await pending;
  });
});
