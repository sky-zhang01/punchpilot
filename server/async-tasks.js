import { randomUUID } from 'node:crypto';
import { isTaskType, isTaskStatus } from '../shared/async-task-contract.js';
import {
  createAsyncTask, updateAsyncTask, getAsyncTask, getDb, insertLog,
  currentExecutionLogIdentityKey, cleanOldAsyncTasks,
} from './db.js';

const activeTaskPromises = new Map();
const taskIdleWaiters = new Set();
// Only lifecycle metadata: results are always read from SQLite.
const unsettledTaskIds = new Set();

function persistence(operation) {
  try { return operation(); } catch (cause) {
    if (cause?.code === 'TASK_STATE_INVALID') throw cause;
    const error = new Error('Task state could not be persisted or read.', { cause });
    error.code = 'TASK_PERSISTENCE_FAILED';
    throw error;
  }
}

function invalidState(message) {
  return Object.assign(new Error(message), { code: 'TASK_STATE_INVALID' });
}

function itemKey(item) {
  return typeof item?.date === 'string' ? item.date : `${item?.type}:${item?.id}`;
}

function readState(row) {
  if (!row.result_json) return null;
  const result = JSON.parse(row.result_json);
  if (!Number.isSafeInteger(result.total) || result.total < 1 || !Array.isArray(result.results)) {
    throw new Error('Stored task state is invalid');
  }
  return result;
}

function confirmedInstant(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function publicTask(row) {
  const state = readState(row);
  const results = state ? [...state.results] : [];
  if (row.status !== 'running' && state?.activeItem && !results.some(item => itemKey(item) === itemKey(state.activeItem))) {
    results.push({ ...state.activeItem, success: false, unknown: true, method: 'unconfirmed', error: 'mutation_outcome_unconfirmed' });
  }
  const succeeded = results.filter(item => item.success === true).length;
  const unknown = results.filter(item => item.unknown === true).length;
  const failed = results.length - succeeded - unknown;
  const total = state?.total ?? null;
  return {
    taskId: row.id,
    taskType: row.task_type,
    status: state ? row.status : 'interrupted',
    createdAt: confirmedInstant(row.created_at),
    completedAt: confirmedInstant(row.completed_at),
    success: !!state && row.status === 'completed' && succeeded === total,
    partial: total === null || results.length < total,
    total,
    processed: results.length,
    succeeded,
    failed,
    unknown,
    results,
    strategy_info: state?.strategy_info ?? null,
    error: state ? row.error_text : 'Detailed results were not saved for this task. Check freee before retrying.',
    code: !state ? 'TASK_RESULT_UNAVAILABLE' : state.code || (row.status === 'interrupted' ? 'TASK_OUTCOME_UNKNOWN' : null),
  };
}

export function createTask(taskType, identity, total) {
  if (!isTaskType(taskType) || !Number.isSafeInteger(total) || total < 1 || total > 50) {
    throw invalidState('A supported task type and item count are required');
  }
  const handle = Object.freeze({ id: randomUUID(), identity: Object.freeze({ ...identity }) });
  persistence(() => createAsyncTask(handle.id, taskType, handle.identity, {
    total, results: [], activeItem: null, strategy_info: null, code: null,
  }));
  return handle;
}

function changeTask(handle, change, executionLog) {
  return persistence(() => getDb().transaction(() => {
    const row = getAsyncTask(handle.id, handle.identity.identityKey);
    if (!row || row.status !== 'running') throw invalidState('Only a running task may be updated');
    const state = readState(row);
    if (!state) throw invalidState('Task results are unavailable');
    const next = change(row, state);
    if (next === false) return publicTask(row);
    if (executionLog) {
      insertLog({ ...executionLog, identity_key: handle.identity.identityKey,
        company_id: handle.identity.companyId, company_name: handle.identity.companyName });
    }
    const updated = updateAsyncTask(handle.id, handle.identity.identityKey, {
      status: row.status, result: state, error: row.error_text,
    });
    if (updated.changes !== 1) throw invalidState('Task ownership changed');
    return publicTask(getAsyncTask(handle.id, handle.identity.identityKey));
  })());
}

export function beginTaskItem(handle, descriptor) {
  return changeTask(handle, (_row, state) => {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
      (typeof descriptor.date !== 'string' && !(Number.isSafeInteger(descriptor.id) && descriptor.id > 0 && typeof descriptor.type === 'string'))) {
      throw invalidState('An item identity is required');
    }
    if (state.results.some(item => itemKey(item) === itemKey(descriptor))) throw invalidState('Task item is already resolved');
    if (state.activeItem && itemKey(state.activeItem) !== itemKey(descriptor)) throw invalidState('Another task item is still unconfirmed');
    state.activeItem = typeof descriptor.date === 'string'
      ? { date: descriptor.date, ...(descriptor.type ? { type: descriptor.type } : {}) }
      : { id: descriptor.id, type: descriptor.type, ...(descriptor.action ? { action: descriptor.action } : {}) };
  });
}

// Use only after a confirmed rejection, before queuing a different strategy.
export function clearTaskItem(handle) {
  return changeTask(handle, (_row, state) => { state.activeItem = null; });
}

export function checkpointTaskResult(handle, result, executionLog) {
  return changeTask(handle, (_row, state) => {
    if (!result || typeof result.success !== 'boolean' || (result.success && result.unknown)) throw invalidState('A confirmed item result is required');
    if (state.results.some(item => itemKey(item) === itemKey(result))) return false;
    if (state.results.length >= state.total) throw invalidState('Task item count exceeded');
    if (state.activeItem && itemKey(state.activeItem) !== itemKey(result)) throw invalidState('Result does not match the active item');
    state.results.push(result);
    state.activeItem = null;
  }, executionLog);
}

export function updateTask(handle, patch) {
  return changeTask(handle, (row, state) => {
    if (patch.status !== undefined) {
      if (!isTaskStatus(patch.status)) throw invalidState('Unsupported task status');
      if (patch.status === 'completed' && (state.activeItem || state.results.length !== state.total)) throw invalidState('Task still has unresolved items');
      row.status = patch.status;
    }
    if (patch.strategy_info !== undefined) state.strategy_info = patch.strategy_info;
    if (patch.code !== undefined) state.code = patch.code;
    if (patch.error !== undefined) row.error_text = patch.error;
  });
}

export function getTask(id, identityKey = currentExecutionLogIdentityKey()) {
  return persistence(() => {
    let row = getAsyncTask(id, identityKey);
    if (!row) return null;
    if (row.status === 'running' && unsettledTaskIds.has(id)) {
      updateTask({ id, identity: { identityKey } }, {
        status: 'interrupted', code: 'TASK_OUTCOME_UNKNOWN',
        error: 'The worker stopped before its result could be saved. Verify freee before retrying.',
      });
      row = getAsyncTask(id, identityKey);
      unsettledTaskIds.delete(id);
    }
    return publicTask(row);
  });
}

export function trackTaskPromise(handle, promise) {
  const tracked = Promise.resolve(promise).catch(() => {
    try {
      const row = getAsyncTask(handle.id, handle.identity.identityKey);
      if (row?.status === 'running') updateTask(handle, {
        status: 'failed', code: 'TASK_PERSISTENCE_FAILED',
        error: 'The worker stopped before its result could be saved. Verify freee before retrying.',
      });
    } catch {
      unsettledTaskIds.add(handle.id);
      console.error('[AsyncTask] Terminal checkpoint unavailable');
    }
  }).finally(() => {
    activeTaskPromises.delete(handle.id);
    if (activeTaskPromises.size === 0) {
      for (const resolve of taskIdleWaiters) resolve(true);
      taskIdleWaiters.clear();
    }
  });
  activeTaskPromises.set(handle.id, tracked);
  return tracked;
}

export function waitForAsyncTasksIdle(timeoutMs = 20_000) {
  if (activeTaskPromises.size === 0) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = idle => {
      if (timer) clearTimeout(timer);
      taskIdleWaiters.delete(finish);
      resolve(idle);
    };
    taskIdleWaiters.add(finish);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    }
  });
}

const taskCleanupTimer = setInterval(() => {
  try { cleanOldAsyncTasks(2); } catch { console.error('[AsyncTask] Cleanup unavailable'); }
}, 5 * 60 * 1000);
taskCleanupTimer.unref?.();
