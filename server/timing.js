import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import logger from './logger.js';

/**
 * Phase timing for user-facing operations.
 *
 * An operation context is started with runTimed(); named phases, freee API
 * calls and a few safe tags are collected while it runs, and ONE info line is
 * written when it ends. Every helper is a no-op (the wrapped function still
 * runs unchanged) when no context is active. Only operation and phase names,
 * durations, counts, status classes, sanitized path templates, booleans and
 * error codes are ever recorded; callers must not pass personal data.
 */
let log = null;
const storage = new AsyncLocalStorage();

const MAX_FREEE_KEYS = 20;
const MAX_PHASES = 40;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

function safeName(value, fallback) {
  return typeof value === 'string' && SAFE_NAME.test(value) ? value : fallback;
}

function safeTagValue(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value));
  return safeName(value, null);
}

// Defense in depth: the caller already passes a sanitized template, but a
// stray ID, date or query string must never reach the log.
function sanitizeTemplate(rawPath) {
  const cleaned = String(rawPath ?? '')
    .split(/[?#]/, 1)[0]
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d[\w.-]*$/.test(segment)) return ':id';
      if (/^[A-Za-z0-9_:-]{1,40}$/.test(segment)) return segment;
      return ':x';
    })
    .join('/');
  return cleaned.slice(0, 80);
}

function statusClass(status) {
  return Number.isInteger(status) && status >= 100 && status < 600
    ? `${Math.floor(status / 100)}xx`
    : 'err';
}

function roundMs(value) {
  return Math.max(0, Math.round(value));
}

function createContext(name, parent) {
  return {
    name: safeName(name, 'unknown'),
    parent,
    startedAt: performance.now(),
    phases: new Map(),
    tags: new Map(),
    freee: { count: 0, total: 0, max: 0, byKey: new Map() },
    tokenRefresh: { count: 0, total: 0 },
    finished: false,
  };
}

function addPhaseTo(ctx, name, ms) {
  const key = safeName(name, null);
  if (!key) return;
  if (!ctx.phases.has(key) && ctx.phases.size >= MAX_PHASES) return;
  ctx.phases.set(key, (ctx.phases.get(key) || 0) + ms);
}

function addFreeeCallTo(ctx, { method, path, status, ms }) {
  const freee = ctx.freee;
  freee.count += 1;
  freee.total += ms;
  if (ms > freee.max) freee.max = ms;
  const verb = safeName(method, '') || 'REQ';
  const key = `${verb}:${sanitizeTemplate(path)}:${statusClass(status)}`;
  if (!freee.byKey.has(key) && freee.byKey.size >= MAX_FREEE_KEYS) return;
  freee.byKey.set(key, (freee.byKey.get(key) || 0) + 1);
}

function formatContext(ctx, totalMs) {
  const parts = [`${ctx.name} total=${roundMs(totalMs)}ms`];
  for (const [key, value] of ctx.tags) parts.push(`${key}=${value}`);
  if (ctx.phases.size > 0) {
    parts.push(
      `phases=${[...ctx.phases].map(([k, v]) => `${k}:${roundMs(v)}`).join(',')}`,
    );
  }
  if (ctx.tokenRefresh.count > 0) {
    parts.push(
      `token_refresh=${ctx.tokenRefresh.count}x/${roundMs(ctx.tokenRefresh.total)}ms`,
    );
  }
  const { freee } = ctx;
  parts.push(`freee_calls=${freee.count}`);
  if (freee.count > 0) {
    parts.push(`freee_total=${roundMs(freee.total)}ms`);
    parts.push(`freee_max=${roundMs(freee.max)}ms`);
    parts.push(
      `freee_by=${[...freee.byKey].map(([k, n]) => `${k}*${n}`).join('|')}`,
    );
  }
  return parts.join(' ');
}

function finish(ctx) {
  if (ctx.finished) return;
  ctx.finished = true;
  try {
    log ??= logger.child('Timing');
    log.info(formatContext(ctx, performance.now() - ctx.startedAt));
  } catch {
    // Timing output must never change the operation result.
  }
}

/**
 * Run fn inside a new operation context and log one line when it settles.
 * Options: { res } adds the HTTP status of that Express response.
 * A thrown error is re-thrown unchanged and only its safe code is logged.
 */
export async function runTimed(name, fn, { res = null } = {}) {
  const ctx = createContext(name, storage.getStore() || null);
  return storage.run(ctx, async () => {
    try {
      return await fn();
    } catch (error) {
      const code = safeName(error?.code, '');
      ctx.tags.set('error', code || safeName(error?.name, 'Error'));
      throw error;
    } finally {
      if (res && Number.isInteger(res.statusCode)) {
        ctx.tags.set('http', String(res.statusCode));
      }
      finish(ctx);
    }
  });
}

/** Time an async (or sync) function as a named phase of the active context. */
export async function timePhase(name, fn) {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    addPhaseTo(ctx, name, performance.now() - startedAt);
  }
}

/**
 * Start a named phase and return a function that ends it (idempotent).
 * For phases whose end does not line up with a function boundary.
 */
export function startPhase(name) {
  const ctx = storage.getStore();
  if (!ctx) return () => {};
  const startedAt = performance.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    addPhaseTo(ctx, name, performance.now() - startedAt);
  };
}

/** Add an already-measured duration to a named phase. */
export function addPhase(name, ms) {
  const ctx = storage.getStore();
  if (!ctx || !Number.isFinite(ms)) return;
  addPhaseTo(ctx, name, ms);
}

/** Attach a safe tag (boolean, number or short token) to the final line. */
export function setTimingTag(key, value) {
  const ctx = storage.getStore();
  if (!ctx) return;
  const safeKey = safeName(key, null);
  const safeValue = safeTagValue(value);
  if (!safeKey || safeValue === null || ctx.tags.size >= MAX_PHASES) return;
  ctx.tags.set(safeKey, safeValue);
}

/** Record a freee API call (sanitized path template, status code, duration). */
export function recordFreeeCall({ method, path, status, ms }) {
  if (!Number.isFinite(ms)) return;
  for (let ctx = storage.getStore(); ctx; ctx = ctx.parent) {
    if (!ctx.finished) addFreeeCallTo(ctx, { method, path, status, ms });
  }
}

/** Record time spent waiting for an OAuth token refresh. */
export function recordTokenRefresh(ms) {
  if (!Number.isFinite(ms)) return;
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.tokenRefresh.count += 1;
  ctx.tokenRefresh.total += ms;
  addPhaseTo(ctx, 'token_refresh', ms);
}

export function hasTimingContext() {
  return storage.getStore() != null;
}

export function timingNow() {
  return performance.now();
}
