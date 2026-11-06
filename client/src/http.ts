export interface ApiResponse<T = any> { data: T; status: number }
export type QueryParams = Record<string, string | number | boolean | null | undefined>;
interface RequestOptions { params?: QueryParams; timeout?: number }

export class ApiError extends Error {
  constructor(message: string, public code?: string, public response?: ApiResponse) {
    super(message);
    this.name = 'ApiError';
  }
}

let identityEpoch = 0;
const identityListeners = new Set<() => void>();
export const getIdentityEpoch = () => identityEpoch;
export function subscribeIdentity(listener: () => void) {
  identityListeners.add(listener);
  return () => { identityListeners.delete(listener); };
}
export function invalidateIdentity() {
  identityEpoch += 1;
  identityListeners.forEach(listener => listener());
}
export function assertIdentity(epoch: number) {
  if (epoch !== identityEpoch) throw new ApiError('Account changed; refresh the current account.', 'IDENTITY_CHANGED');
}

async function request<T = any>(method: string, path: string, data?: unknown, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const epoch = identityEpoch;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value === null || value === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new ApiError('Query values must be primitive.', 'INVALID_QUERY');
    query.set(key, String(value));
  }
  const controller = new AbortController();
  const timeoutMs = options.timeout ?? 0;
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(`/api${path}${query.size ? `?${query}` : ''}`, {
      method,
      credentials: 'include',
      headers: { 'X-PunchPilot-Request': '1', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: controller.signal,
    });
    const text = await response.text();
    assertIdentity(epoch);
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* Preserve non-JSON error bodies and empty responses. */ }
    const result = { data: parsed as T, status: response.status };
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith('/auth/')) window.location.href = '/login';
      throw new ApiError(`Request failed with status code ${response.status}`, parsed?.code, result);
    }
    return result;
  } catch (error) {
    assertIdentity(epoch);
    if (controller.signal.aborted) throw new ApiError(`timeout of ${timeoutMs}ms exceeded`, 'ECONNABORTED');
    throw error;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

const http = {
  get: <T = any>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T = any>(path: string, data?: unknown, options?: RequestOptions) => request<T>('POST', path, data, options),
  put: <T = any>(path: string, data?: unknown, options?: RequestOptions) => request<T>('PUT', path, data, options),
  delete: <T = any>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
};
export default http;
