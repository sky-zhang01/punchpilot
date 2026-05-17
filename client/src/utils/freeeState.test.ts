import { describe, expect, it } from 'vitest';
import { BADGE_STATUS, HINT_KEYS, STATE_COLORS, STATE_LABEL_KEYS } from './freeeState';

describe('freeeState UI mappings', () => {
  it('keeps every primary attendance state visible and labelled', () => {
    for (const state of ['not_checked_in', 'working', 'on_break', 'checked_out', 'unknown']) {
      expect(STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(STATE_LABEL_KEYS[state]).toBeTruthy();
      expect(BADGE_STATUS[state]).toBeTruthy();
    }
  });

  it('keeps action hints limited to actionable states', () => {
    expect(Object.keys(HINT_KEYS).sort()).toEqual([
      'checked_out',
      'not_checked_in',
      'on_break',
      'working',
    ]);
    expect(HINT_KEYS.unknown).toBeUndefined();
  });
});
