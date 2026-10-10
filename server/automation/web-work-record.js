import { ACTION_SELECTORS } from './constants.js';
import { workRecordMatchesDate } from '../work-record-status.js';

const FREEE_WEB_ORIGIN = 'https://p.secure.freee.co.jp';
const ATTENDANCE_URL = `${FREEE_WEB_ORIGIN}/attendances`;
const TIME_CLOCK_URL = `${FREEE_WEB_ORIGIN}/`;
const WORK_RECORD_PATH_PREFIX = '/api/p/employees/work_records/';
const WORK_RECORD_PATH_PATTERN = /^\/api\/p\/employees\/work_records\/([1-9]\d*)\/(\d{4})\/(\d{1,2})$/;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_WORK_RECORDS = 62;
const MAX_PAID_HOLIDAY_ENTRIES = 16;
const MAX_BREAK_RECORDS = 32;
const MAX_WORK_RECORD_SEGMENTS = 64;
const MAX_FIELD_LENGTH = 128;
const WEB_PAID_HOLIDAY_TYPES = new Map([
  ['full', 'full'],
  ['half', 'half'],
  ['morning_off', 'morning_off'],
  ['afternoon_off', 'afternoon_off'],
  ['hourly', 'hourly'],
  ['paid_holiday_full', 'full'],
]);

export const WEB_WORK_RECORD_ERROR_CODES = Object.freeze({
  UNCONFIRMED: 'WEB_WORK_RECORD_UNCONFIRMED',
  SCHEMA_UNSUPPORTED: 'WEB_WORK_RECORD_SCHEMA_UNSUPPORTED',
  RESPONSE_TOO_LARGE: 'WEB_WORK_RECORD_RESPONSE_TOO_LARGE',
});

export const WEB_NON_WORKING_DAY_CONFIRMED = 'WEB_NON_WORKING_DAY_CONFIRMED';

function webWorkRecordError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeNumber(value) {
  return value === undefined || value === null || isNonNegativeNumber(value);
}

function isBoundedString(value) {
  return typeof value === 'string' && value.length <= MAX_FIELD_LENGTH;
}

function isOptionalString(value) {
  return value === null || isBoundedString(value);
}

function isBooleanFlag(value) {
  return typeof value === 'boolean' || value === 0 || value === 1;
}

function normalizeOptionalNumber(value) {
  return value === undefined || value === null ? 0 : value;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

function validClockRecord(record) {
  return isPlainRecord(record) &&
    isOptionalString(record.clock_in_at) &&
    isOptionalString(record.clock_out_at);
}

export function isWebWorkRecordResponse(response) {
  try {
    const url = new URL(response.url());
    return response.request().method() === 'GET' &&
      url.origin === FREEE_WEB_ORIGIN &&
      url.pathname.startsWith(WORK_RECORD_PATH_PREFIX) &&
      WORK_RECORD_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function webWorkRecordTarget(response) {
  try {
    const url = new URL(response.url());
    const match = url.pathname.match(WORK_RECORD_PATH_PATTERN);
    if (
      response.request().method() !== 'GET' ||
      url.origin !== FREEE_WEB_ORIGIN ||
      !match
    ) return null;
    return {
      employeeId: match[1],
      year: Number.parseInt(match[2], 10),
      month: Number.parseInt(match[3], 10),
    };
  } catch {
    return null;
  }
}

export function normalizeWebWorkRecordPayload(payload, expectedDate) {
  if (
    typeof expectedDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !Array.isArray(payload.work_records) ||
    payload.work_records.length === 0 ||
    payload.work_records.length > MAX_WORK_RECORDS
  ) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
      'freee Web work-record response schema is unsupported.',
    );
  }

  const source = payload.work_records.find((record) =>
    workRecordMatchesDate(record, expectedDate));
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web did not return the requested work record.',
    );
  }

  const requiredFields = [
    'paid_holiday',
    'paid_holidays',
    'special_holiday',
    'normal_work_mins',
    'day_pattern',
    'schedule_pattern',
    'clock_in_at',
    'clock_out_at',
    'break_records',
  ];
  const absence = hasOwn(source, 'is_absence')
    ? source.is_absence
    : source.absence_f;
  const optionalNumericFields = [
    'normal_work_mins_by_paid_holiday',
    'half_paid_holiday_mins',
    'hourly_paid_holiday_mins',
    'half_special_holiday_mins',
    'hourly_special_holiday_mins',
  ];
  const paidHolidayEntriesValid =
    Array.isArray(source.paid_holidays) &&
    source.paid_holidays.length <= MAX_PAID_HOLIDAY_ENTRIES &&
    source.paid_holidays.every((entry) =>
      isPlainRecord(entry) &&
      isBoundedString(entry.type) &&
      WEB_PAID_HOLIDAY_TYPES.has(entry.type) &&
      isNonNegativeNumber(entry.days) &&
      isNonNegativeNumber(entry.mins));
  const breakRecordsValid =
    Array.isArray(source.break_records) &&
    source.break_records.length <= MAX_BREAK_RECORDS &&
    source.break_records.every(validClockRecord);
  if (
    requiredFields.some((field) => !hasOwn(source, field)) ||
    (!hasOwn(source, 'absence_f') && !hasOwn(source, 'is_absence')) ||
    !Array.isArray(source.paid_holidays) ||
    !Array.isArray(source.break_records) ||
    !isBooleanFlag(absence) ||
    !isNonNegativeNumber(source.paid_holiday) ||
    !isNonNegativeNumber(source.special_holiday) ||
    !isNonNegativeNumber(source.normal_work_mins) ||
    optionalNumericFields.some((field) =>
      !isOptionalNonNegativeNumber(source[field])) ||
    !isBoundedString(source.day_pattern) ||
    !isOptionalString(source.schedule_pattern) ||
    !isOptionalString(source.clock_in_at) ||
    !isOptionalString(source.clock_out_at) ||
    !paidHolidayEntriesValid ||
    !breakRecordsValid
  ) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
      'freee Web work-record fields are unsupported.',
    );
  }

  const segments = Array.isArray(source.employee_work_record_segments)
    ? source.employee_work_record_segments
    : Array.isArray(source.work_record_segments)
      ? source.work_record_segments
      : [];
  if (
    segments.length > MAX_WORK_RECORD_SEGMENTS ||
    !segments.every(validClockRecord)
  ) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
      'freee Web work-record segment fields are unsupported.',
    );
  }

  return {
    date: source.date,
    clock_in_at: normalizeOptionalString(source.clock_in_at),
    clock_out_at: normalizeOptionalString(source.clock_out_at),
    break_records: source.break_records.map((record) => ({
      clock_in_at: normalizeOptionalString(record.clock_in_at),
      clock_out_at: normalizeOptionalString(record.clock_out_at),
    })),
    work_record_segments: segments.map((segment) => ({
      clock_in_at: normalizeOptionalString(segment.clock_in_at),
      clock_out_at: normalizeOptionalString(segment.clock_out_at),
    })),
    is_absence: absence === true || absence === 1,
    paid_holiday: source.paid_holiday,
    paid_holidays: source.paid_holidays.map((entry) => ({
      type: WEB_PAID_HOLIDAY_TYPES.get(entry.type),
      days: entry.days,
      mins: entry.mins,
    })),
    normal_work_mins: source.normal_work_mins,
    normal_work_mins_by_paid_holiday: normalizeOptionalNumber(
      source.normal_work_mins_by_paid_holiday,
    ),
    half_paid_holiday_mins: normalizeOptionalNumber(source.half_paid_holiday_mins),
    hourly_paid_holiday_mins: normalizeOptionalNumber(source.hourly_paid_holiday_mins),
    special_holiday: source.special_holiday,
    half_special_holiday_mins: normalizeOptionalNumber(source.half_special_holiday_mins),
    hourly_special_holiday_mins: normalizeOptionalNumber(source.hourly_special_holiday_mins),
    day_pattern: source.day_pattern,
    schedule_pattern: source.schedule_pattern || '',
  };
}

async function readBoundedJson(response) {
  if (!response?.ok()) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record request was not successful.',
    );
  }
  const contentLengthHeader = response.headers()?.['content-length'];
  const contentLength = contentLengthHeader === undefined
    ? null
    : Number(contentLengthHeader);
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(contentLength) || contentLength < 0)
  ) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record response length was invalid.',
    );
  }
  if (contentLength !== null && contentLength > MAX_RESPONSE_BYTES) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.RESPONSE_TOO_LARGE,
      'freee Web work-record response exceeded the size limit.',
    );
  }
  const body = await response.body();
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_RESPONSE_BYTES) {
    throw webWorkRecordError(
      Buffer.isBuffer(body) && body.length > MAX_RESPONSE_BYTES
        ? WEB_WORK_RECORD_ERROR_CODES.RESPONSE_TOO_LARGE
        : WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record response could not be confirmed.',
    );
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.SCHEMA_UNSUPPORTED,
      'freee Web work-record response was not valid JSON.',
    );
  }
}

async function observeWebWorkRecordResponse(page) {
  const responsePromise = page.waitForResponse(isWebWorkRecordResponse, {
    timeout: 15_000,
  }).then(
    (response) => ({ response }),
    () => ({ response: null }),
  );

  try {
    const attendanceLink = page
      .locator("a, button, [role='link'], [role='button']")
      .filter({ hasText: /^\s*勤怠\s*$/ })
      .first();
    const linkVisible =
      (await attendanceLink.count()) > 0 &&
      (await attendanceLink.isVisible().catch(() => false));

    if (linkVisible) {
      await attendanceLink.click({ timeout: 10_000 });
    } else {
      await page.goto(ATTENDANCE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
    }
  } catch {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record page could not be opened.',
    );
  }

  const { response } = await responsePromise;
  if (!response) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record request was not observed.',
    );
  }
  return response;
}

export async function readWebEmployeeIdentity(page) {
  const response = await observeWebWorkRecordResponse(page);
  const target = webWorkRecordTarget(response);
  if (!target || !response.ok()) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web employee identity could not be confirmed.',
    );
  }
  return { employeeId: target.employeeId };
}

export async function readWebWorkRecord(page, expectedDate) {
  const response = await observeWebWorkRecordResponse(page);
  const payload = await readBoundedJson(response);
  return normalizeWebWorkRecordPayload(payload, expectedDate);
}

export async function rereadWebWorkRecord(page, expectedDate, employeeId) {
  const normalizedEmployeeId = String(employeeId || '').trim();
  const dateMatch = String(expectedDate || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!/^[1-9]\d*$/.test(normalizedEmployeeId) || !dateMatch) {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record target could not be confirmed.',
    );
  }

  const requestContext = page?.context?.()?.request;
  if (!requestContext || typeof requestContext.get !== 'function') {
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record request context was unavailable.',
    );
  }
  const targetUrl = `${FREEE_WEB_ORIGIN}${WORK_RECORD_PATH_PREFIX}` +
    `${normalizedEmployeeId}/${dateMatch[1]}/${Number(dateMatch[2])}`;
  let response;
  try {
    response = await requestContext.get(targetUrl, {
      failOnStatusCode: false,
      headers: { Accept: 'application/json' },
      timeout: 15_000,
    });
    if (response.url() !== targetUrl) {
      throw webWorkRecordError(
        WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
        'freee Web work-record request left the expected endpoint.',
      );
    }
    const payload = await readBoundedJson(response);
    return normalizeWebWorkRecordPayload(payload, expectedDate);
  } catch (error) {
    if (Object.values(WEB_WORK_RECORD_ERROR_CODES).includes(error?.code)) {
      throw error;
    }
    throw webWorkRecordError(
      WEB_WORK_RECORD_ERROR_CODES.UNCONFIRMED,
      'freee Web work-record could not be rechecked.',
    );
  } finally {
    await response?.dispose?.().catch(() => {});
  }
}

export async function returnToWebTimeClockPage(page) {
  await page.goto(TIME_CLOCK_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  await page.waitForSelector(Object.values(ACTION_SELECTORS).join(', '), {
    state: 'attached',
    timeout: 15_000,
  });
}
