const NON_WORKING_DAY_PATTERNS = new Set([
  "prescribed_holiday",
  "legal_holiday",
]);

const NON_WORKING_SCHEDULE_PATTERNS = new Set([
  "substitute_holiday",
  "compensatory_holiday",
  "special_holiday",
]);
const WORKING_DAY_PATTERNS = new Set([
  "normal_day",
  ...NON_WORKING_DAY_PATTERNS,
]);
const SCHEDULE_PATTERNS = new Set([
  "",
  "substitute_holiday_work",
  "compensatory_holiday_work",
  ...NON_WORKING_SCHEDULE_PATTERNS,
]);
const PAID_HOLIDAY_TYPES = new Set([
  "full",
  "half",
  "morning_off",
  "afternoon_off",
  "hourly",
]);
const STATUS_NUMBER_FIELDS = [
  "normal_work_mins",
  "paid_holiday",
  "normal_work_mins_by_paid_holiday",
  "half_paid_holiday_mins",
  "hourly_paid_holiday_mins",
  "special_holiday",
  "half_special_holiday_mins",
  "hourly_special_holiday_mins",
];
const COMPLETE_STATUS_FIELDS = [
  "normal_work_mins",
  "is_absence",
  "special_holiday",
  "half_special_holiday_mins",
  "hourly_special_holiday_mins",
  "day_pattern",
  "schedule_pattern",
  "clock_in_at",
  "clock_out_at",
  "work_record_segments",
  "break_records",
];
const LEGACY_PAID_HOLIDAY_FIELDS = [
  "paid_holiday",
  "half_paid_holiday_mins",
  "hourly_paid_holiday_mins",
];

function hasOwn(record, field) {
  return Object.hasOwn(record, field);
}

function validOptionalNonNegativeNumber(value) {
  return value == null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validOptionalString(value) {
  return value == null || typeof value === "string";
}

function validTimeRanges(value) {
  return value == null ||
    (Array.isArray(value) && value.every((entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      validOptionalString(entry.clock_in_at) &&
      validOptionalString(entry.clock_out_at)));
}

function workRecordStatusShapeConfirmed(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (STATUS_NUMBER_FIELDS.some((field) =>
    !validOptionalNonNegativeNumber(Reflect.get(record, field)))) return false;
  if (record.is_absence != null && typeof record.is_absence !== "boolean") {
    return false;
  }
  if (
    (record.day_pattern != null && !WORKING_DAY_PATTERNS.has(record.day_pattern)) ||
    (record.schedule_pattern != null && !SCHEDULE_PATTERNS.has(record.schedule_pattern)) ||
    !validOptionalString(record.clock_in_at) ||
    !validOptionalString(record.clock_out_at) ||
    !validTimeRanges(record.work_record_segments) ||
    !validTimeRanges(record.break_records)
  ) {
    return false;
  }
  if (
    record.special_holiday_setting_id != null &&
    (!Number.isSafeInteger(record.special_holiday_setting_id) ||
      record.special_holiday_setting_id <= 0)
  ) {
    return false;
  }
  return record.paid_holidays == null ||
    (Array.isArray(record.paid_holidays) && record.paid_holidays.every((entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      PAID_HOLIDAY_TYPES.has(entry.type) &&
      validOptionalNonNegativeNumber(entry.days) &&
      validOptionalNonNegativeNumber(entry.mins)));
}

function workRecordClockShapeComplete(record) {
  return [
    "clock_in_at",
    "clock_out_at",
    "work_record_segments",
    "break_records",
  ].every((field) => hasOwn(record, field));
}

function workRecordNegativeStatusComplete(record) {
  const paidHolidayShapeComplete = hasOwn(record, "paid_holidays") ||
    LEGACY_PAID_HOLIDAY_FIELDS.every((field) => hasOwn(record, field));
  return paidHolidayShapeComplete &&
    COMPLETE_STATUS_FIELDS.every((field) => hasOwn(record, field));
}

function unconfirmedStatus() {
  return {
    confirmed: false,
    isNonWorkingDay: false,
    reason: null,
    code: "work_record_unconfirmed",
  };
}

function confirmedStatus(isNonWorkingDay, reason = null, code = null) {
  return { confirmed: true, isNonWorkingDay, reason, code };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function hasWorkRecordClockTimes(record) {
  if (!record || typeof record !== "object") return false;
  if (record.clock_in_at || record.clock_out_at) return true;
  const workRecordSegments = Array.isArray(record.work_record_segments)
    ? record.work_record_segments
    : [];
  if (
    workRecordSegments.some(
      (segment) => segment?.clock_in_at || segment?.clock_out_at,
    )
  ) {
    return true;
  }
  const breakRecords = Array.isArray(record.break_records)
    ? record.break_records
    : [];
  return breakRecords.some((br) => br?.clock_in_at || br?.clock_out_at);
}

export function workRecordMatchesDate(record, expectedDate) {
  if (!record || typeof record !== "object" || typeof record.date !== "string") {
    return false;
  }
  return (
    record.date === expectedDate ||
    (record.date.slice(0, 10) === expectedDate &&
      ["T", " "].includes(record.date.charAt(10)))
  );
}

export function isEditableWorkRecord(record, expectedDate) {
  return Boolean(record && typeof record === 'object' && !Array.isArray(record) &&
    workRecordMatchesDate(record, expectedDate) && record.is_editable === true);
}

function paidHolidayTotals(record) {
  const entries = Array.isArray(record.paid_holidays)
    ? record.paid_holidays
    : [];
  const structuredDays = entries.reduce(
    (total, entry) => total + Math.max(0, toNumber(entry?.days)),
    0,
  );
  const structuredMins = entries.reduce(
    (total, entry) => total + Math.max(0, toNumber(entry?.mins)),
    0,
  );
  const legacyMins = Math.max(
    toNumber(record.normal_work_mins_by_paid_holiday),
    toNumber(record.half_paid_holiday_mins) +
      toNumber(record.hourly_paid_holiday_mins),
  );

  return {
    days: Math.max(toNumber(record.paid_holiday), structuredDays),
    mins: Math.max(structuredMins, legacyMins),
    hasFullEntry: entries.some((entry) => entry?.type === "full"),
  };
}

export function getWorkRecordLeaveCoverage(record) {
  if (!record || typeof record !== "object") {
    return { hasPaidLeave: false, hasSpecialLeave: false, hasAnyLeave: false };
  }
  const paidHoliday = paidHolidayTotals(record);
  const hasPaidLeave =
    paidHoliday.hasFullEntry || paidHoliday.days > 0 || paidHoliday.mins > 0;
  const hasSpecialLeave =
    toNumber(record.special_holiday) > 0 ||
    toNumber(record.half_special_holiday_mins) > 0 ||
    toNumber(record.hourly_special_holiday_mins) > 0;
  return {
    hasPaidLeave,
    hasSpecialLeave,
    hasAnyLeave: hasPaidLeave || hasSpecialLeave,
  };
}

/**
 * Decide whether a freee work_record represents a full non-working day.
 * Half-day/hourly paid leave is intentionally not treated as a full-day skip.
 */
export function getWorkRecordNonWorkingDayStatus(record) {
  if (!workRecordStatusShapeConfirmed(record)) {
    return unconfirmedStatus();
  }

  if (record.is_absence === true) {
    return confirmedStatus(
      true,
      "freee work record marks the date as absence",
      "absence",
    );
  }

  const normalWorkMins = toNumber(record.normal_work_mins);
  const specialHolidayDays = toNumber(record.special_holiday);
  const specialHolidayMins =
    toNumber(record.half_special_holiday_mins) +
    toNumber(record.hourly_special_holiday_mins);
  if (
    specialHolidayDays >= 1 ||
    (normalWorkMins > 0 && specialHolidayMins >= normalWorkMins)
  ) {
    return confirmedStatus(
      true,
      "freee work record marks the date as special holiday",
      "special_holiday",
    );
  }

  const paidHoliday = paidHolidayTotals(record);
  const combinedLeaveDays = paidHoliday.days + specialHolidayDays;
  const combinedLeaveMins = paidHoliday.mins + specialHolidayMins;
  const hasPaidHolidayCoverage =
    paidHoliday.hasFullEntry || paidHoliday.days > 0 || paidHoliday.mins > 0;
  const hasSpecialHolidayCoverage =
    specialHolidayDays > 0 || specialHolidayMins > 0;
  if (
    hasPaidHolidayCoverage &&
    hasSpecialHolidayCoverage &&
    (combinedLeaveDays >= 1 ||
      (normalWorkMins > 0 && combinedLeaveMins >= normalWorkMins))
  ) {
    return confirmedStatus(
      true,
      "freee work record leave entries cover the full work day",
      "combined_full_day_leave",
    );
  }

  if (paidHoliday.hasFullEntry || paidHoliday.days >= 1) {
    return confirmedStatus(
      true,
      "freee work record marks the date as full-day paid holiday",
      "paid_holiday",
    );
  }

  if (normalWorkMins > 0 && paidHoliday.mins >= normalWorkMins) {
    return confirmedStatus(
      true,
      "freee work record covers normal work minutes with paid holiday",
      "paid_holiday_minutes",
    );
  }

  const dayPattern = String(record.day_pattern || "");
  const schedulePattern = String(record.schedule_pattern || "");
  if (
    (NON_WORKING_DAY_PATTERNS.has(dayPattern) ||
      NON_WORKING_SCHEDULE_PATTERNS.has(schedulePattern)) &&
    workRecordClockShapeComplete(record) &&
    !hasWorkRecordClockTimes(record)
  ) {
    const pattern = NON_WORKING_SCHEDULE_PATTERNS.has(schedulePattern)
      ? schedulePattern
      : dayPattern;
    return confirmedStatus(
      true,
      `freee work record marks the date as ${pattern}`,
      "non_working_day_pattern",
    );
  }

  if (!workRecordNegativeStatusComplete(record)) return unconfirmedStatus();
  return confirmedStatus(false);
}
