import { expect, it } from 'vitest';
import { parseMilliseconds } from '../server/runtime-config.js';

it('defaults only absent operator timeouts and accepts valid timer limits', () => {
  for (const input of [undefined, null, '']) expect(parseMilliseconds(input, 'TIMEOUT', 30)).toBe(30);
  expect(parseMilliseconds('480000', 'TIMEOUT', 30, 480000)).toBe(480000);
  expect(parseMilliseconds(2147483647, 'TIMEOUT', 30)).toBe(2147483647);
});

it.each(['123junk', '1e3', '1.5', ' 10', -1, 0, true, [], 2147483648])('rejects unsafe timer input %j', (value) => {
  expect(() => parseMilliseconds(value, 'TIMEOUT', 30)).toThrow('TIMEOUT');
});

it('rejects a timeout over its operation budget', () => {
  expect(() => parseMilliseconds('480001', 'OPERATION', 30, 480000)).toThrow('OPERATION');
});
