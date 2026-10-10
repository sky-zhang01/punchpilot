/** Read an operator timeout without accepting partial numbers or timer overflow. */
export function parseMilliseconds(value, name, fallback, max = 2_147_483_647) {
  if (value == null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export const AUTOMATION_QUEUE_TIMEOUT_MS = parseMilliseconds(
  process.env.AUTOMATION_QUEUE_TIMEOUT_MS, 'AUTOMATION_QUEUE_TIMEOUT_MS', 540_000,
);
