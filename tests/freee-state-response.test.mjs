import { describe, expect, it } from 'vitest';

import { FREEE_STATE } from '../server/constants.js';
import {
  FREEE_API_ERROR_CODES,
  parseAvailableClockTypesResponse,
} from '../server/freee-api.js';

const TODAY = '2026-07-12';

describe('freee available clock types response contract', () => {
  it.each([
    [[], FREEE_STATE.CHECKED_OUT],
    [['clock_in'], FREEE_STATE.NOT_CHECKED_IN],
    [['break_begin', 'clock_out'], FREEE_STATE.WORKING],
    [['clock_out'], FREEE_STATE.WORKING],
    [['break_end', 'clock_out'], FREEE_STATE.ON_BREAK],
  ])('maps a confirmed occurrence %j', (availableTypes, state) => {
    expect(parseAvailableClockTypesResponse({
      available_types: availableTypes,
      base_date: TODAY,
    }, TODAY)).toEqual({
      state,
      baseDate: TODAY,
      availableTypes,
    });
  });

  it.each([
    null,
    {},
    [],
    { available_types: null, base_date: TODAY },
    { available_types: 'clock_in', base_date: TODAY },
    { available_types: ['unknown'], base_date: TODAY },
    { available_types: ['clock_in', 'clock_in'], base_date: TODAY },
    { available_types: ['clock_in', 'clock_out'], base_date: TODAY },
    { available_types: ['clock_in'], base_date: null },
    { available_types: ['clock_in'], base_date: '2026-7-12' },
  ])('rejects an unconfirmed successful payload %#', (payload) => {
    expect(() => parseAvailableClockTypesResponse(payload, TODAY)).toThrow(
      expect.objectContaining({
        code: FREEE_API_ERROR_CODES.API_RESPONSE_UNCONFIRMED,
      }),
    );
  });

  it('rejects a cross-day occurrence instead of applying today schedule to it', () => {
    expect(() => parseAvailableClockTypesResponse({
      available_types: ['clock_out'],
      base_date: '2026-07-11',
    }, TODAY)).toThrow(expect.objectContaining({
      code: FREEE_API_ERROR_CODES.ATTENDANCE_BASE_DATE_MISMATCH,
    }));
  });
});
