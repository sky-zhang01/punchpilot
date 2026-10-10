import { AUTOMATION_QUEUE_TIMEOUT_MS as DEFAULT_QUEUE_TIMEOUT_MS } from './runtime-config.js';

let active = false;
let accepting = true;
const queue = [];
const idleWaiters = new Set();

function notifyIdle() {
  if (active || queue.length > 0) return;
  for (const resolve of idleWaiters) resolve(true);
  idleWaiters.clear();
}

export function acquireAccountOperation(timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!accepting) {
      const error = new Error("The account operation service is shutting down.");
      error.code = "ACCOUNT_OPERATION_SHUTTING_DOWN";
      reject(error);
      return;
    }
    if (!active) {
      active = true;
      resolve();
      return;
    }

    const entry = { resolve, reject, timer: null };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        const error = new Error("The account operation queue timed out.");
        error.code = "ACCOUNT_OPERATION_QUEUE_TIMEOUT";
        reject(error);
      }, timeoutMs);
      entry.timer.unref?.();
    }
    queue.push(entry);
  });
}

export function beginAccountOperationShutdown() {
  if (!accepting) return;
  accepting = false;
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry.timer) clearTimeout(entry.timer);
    const error = new Error("The account operation service is shutting down.");
    error.code = "ACCOUNT_OPERATION_SHUTTING_DOWN";
    entry.reject(error);
  }
  notifyIdle();
}

export function releaseAccountOperation() {
  const next = queue.shift();
  if (next) {
    if (next.timer) clearTimeout(next.timer);
    next.resolve();
    return;
  }
  active = false;
  notifyIdle();
}

export async function withAccountOperation(operation, timeoutMs) {
  await acquireAccountOperation(timeoutMs);
  try {
    return await operation();
  } finally {
    releaseAccountOperation();
  }
}

export function waitForAccountOperationsIdle(timeoutMs = 20_000) {
  if (!active && queue.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (idle) => {
      if (timer) clearTimeout(timer);
      idleWaiters.delete(finish);
      resolve(idle);
    };
    idleWaiters.add(finish);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    }
  });
}
