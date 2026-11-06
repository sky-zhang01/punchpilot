import http, { ApiError, assertIdentity, getIdentityEpoch, subscribeIdentity, type ApiResponse } from './http';
import { isTaskType, isTaskStatus, type TASK_TYPES, type TASK_STATUSES } from '../../shared/async-task-contract.js';

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export interface StrategyInfo {
  direct_disabled: boolean;
  approval_route_blocked: boolean;
  approval_route_verified?: boolean;
  web_fallback_used: boolean;
  web_credentials_configured: boolean;
}
export interface TaskItemResult {
  date?: string;
  id?: number;
  type?: string;
  action?: string;
  success: boolean;
  unknown?: boolean;
  error?: string;
  reason?: string;
  method?: string;
  [key: string]: unknown;
}
export interface TaskDTO {
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  createdAt: string | null;
  completedAt: string | null;
  success: boolean;
  partial: boolean;
  total: number | null;
  processed: number;
  succeeded: number;
  failed: number;
  unknown: number;
  results: TaskItemResult[];
  strategy_info: StrategyInfo | null;
  error: string | null;
  code: string | null;
}
interface TaskReference { taskId: string; taskType: TaskType }
const storageKey = 'punchpilot.tasks';
const snapshots = new Map<string, TaskDTO>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
export const getTaskSnapshots = () => Array.from(snapshots.values());
export function subscribeTasks(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
subscribeIdentity(() => { snapshots.clear(); notify(); });

export function getTaskReferences(): TaskReference[] {
  try {
    const rows: unknown = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
    return Array.isArray(rows) ? rows.filter((row): row is TaskReference =>
      !!row && typeof row.taskId === 'string' && isTaskType(row.taskType)) : [];
  } catch { return []; }
}
function rememberTask(reference: TaskReference) {
  const rows = getTaskReferences().filter(row => row.taskId !== reference.taskId);
  // Persist only opaque references. Results must be read through the server's identity boundary.
  try { sessionStorage.setItem(storageKey, JSON.stringify([...rows, reference])); } catch { /* Storage can be disabled; the live request still carries its taskId. */ }
  notify();
}
export function forgetTask(taskId: string) {
  try { sessionStorage.setItem(storageKey, JSON.stringify(getTaskReferences().filter(row => row.taskId !== taskId))); } catch { /* In-memory display remains usable. */ }
  snapshots.delete(taskId);
  notify();
}
export function clearTaskReferences() {
  try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage may be unavailable. */ }
  snapshots.clear();
  notify();
}
export class TaskError extends Error {
  constructor(message: string, public taskId: string, public task: TaskDTO | null, public code: string) {
    super(message);
    this.name = 'TaskError';
  }
}
export interface TaskFailure { message: string; taskId: string; task: TaskDTO | null; code: string }
export function taskFailure(error: unknown): TaskFailure | null {
  return error instanceof TaskError ? { message: error.message, taskId: error.taskId, task: error.task, code: error.code } : null;
}
function isTaskDTO(value: unknown, taskId: string): value is TaskDTO {
  if (!value || typeof value !== 'object') return false;
  const task = value as TaskDTO;
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const optionalText = (value: unknown) => value == null || typeof value === 'string';
  if (task.taskId !== taskId || !isTaskType(task.taskType)
    || !isTaskStatus(task.status)
    || typeof task.success !== 'boolean' || typeof task.partial !== 'boolean'
    || ![task.processed, task.succeeded, task.failed, task.unknown].every(count)
    || !(task.total === null || count(task.total))
    || task.processed !== task.succeeded + task.failed + task.unknown
    || (task.total !== null && task.processed > task.total)
    || !optionalText(task.error) || !optionalText(task.code)
    || !Array.isArray(task.results) || task.results.length !== task.processed) return false;
  if (!task.results.every(result => result && typeof result === 'object'
    && typeof result.success === 'boolean'
    && (result.unknown === undefined || typeof result.unknown === 'boolean')
    && !(result.success && result.unknown)
    && ['date', 'type', 'action', 'error', 'reason', 'method'].every(key => optionalText(result[key]))
    && (result.id === undefined || count(result.id)))) return false;
  if (task.results.filter(result => result.unknown).length !== task.unknown
    || task.results.filter(result => result.success).length !== task.succeeded) return false;
  if (task.success && (task.status !== 'completed' || task.total === null || task.total !== task.succeeded || task.partial)) return false;
  return task.strategy_info == null || (typeof task.strategy_info === 'object'
    && ['direct_disabled', 'approval_route_blocked', 'web_fallback_used', 'web_credentials_configured'].every(key =>
      typeof task.strategy_info?.[key as keyof StrategyInfo] === 'boolean'));
}
export async function getTask(taskId: string, timeout = 60_000): Promise<ApiResponse<TaskDTO>> {
  const epoch = getIdentityEpoch();
  const response = await http.get<unknown>(`/attendance/batch/status/${encodeURIComponent(taskId)}`, { timeout });
  assertIdentity(epoch);
  if (!isTaskDTO(response.data, taskId)) throw new ApiError('Invalid task response; query again before taking further action.', 'TASK_RESPONSE_INVALID');
  const result = { ...response, data: response.data };
  snapshots.set(taskId, result.data);
  notify();
  return result;
}
export async function pollTask(taskId: string, { intervalMs = 2000, maxMs = 600000 } = {}): Promise<TaskDTO> {
  const started = Date.now();
  const epoch = getIdentityEpoch();
  let latest: TaskDTO | null = snapshots.get(taskId) || null;
  try {
    while (Date.now() - started < maxMs) {
      assertIdentity(epoch);
      latest = (await getTask(taskId, Math.min(60_000, Math.max(1, maxMs - (Date.now() - started))))).data;
      assertIdentity(epoch);
      if (latest.status === 'completed') return latest;
      if (latest.status === 'failed' || latest.status === 'interrupted') {
        throw new TaskError(latest.error || 'Task stopped; review its recorded results.', taskId, latest, latest.code || 'TASK_OUTCOME_UNKNOWN');
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new TaskError('Polling paused; the task may still be running. Resume querying its results.', taskId, latest, 'TASK_POLL_TIMEOUT');
  } catch (error) {
    assertIdentity(epoch); // Never return another account's cached evidence after a switch.
    if (error instanceof TaskError) throw error;
    throw new TaskError(error instanceof Error ? error.message : 'Task query failed', taskId, latest, Date.now() - started >= maxMs ? 'TASK_POLL_TIMEOUT' : 'TASK_QUERY_FAILED');
  }
}
export async function resumeTask(taskId: string): Promise<ApiResponse<TaskDTO>> {
  const epoch = getIdentityEpoch();
  const data = await pollTask(taskId);
  assertIdentity(epoch);
  return { data, status: 200 };
}
export async function asyncBatchRequest(url: string, data: unknown, taskType: TaskType): Promise<ApiResponse<TaskDTO>> {
  const epoch = getIdentityEpoch();
  let response: ApiResponse<{ task_id: string }>;
  try { response = await http.post<{ task_id: string }>(url, data); }
  catch (error) {
    assertIdentity(epoch);
    if (error instanceof ApiError && (error.code === 'IDENTITY_CHANGED'
      || (error.response && error.response.status < 500)
      || (error.response?.status === 503 && error.code === 'TASK_PERSISTENCE_FAILED'))) throw error;
    throw new ApiError('Task admission is unconfirmed. Check freee and logs before submitting again.', 'TASK_ADMISSION_UNKNOWN');
  }
  assertIdentity(epoch);
  const taskId = response.data?.task_id;
  if (typeof taskId !== 'string' || !taskId) throw new ApiError('Batch admission did not return a task id; check freee and logs before submitting again.', 'TASK_ADMISSION_UNKNOWN');
  rememberTask({ taskId, taskType });
  return resumeTask(taskId);
}
