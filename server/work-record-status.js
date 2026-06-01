const NON_WORKING_DAY_PATTERNS = new Set([
  "prescribed_holiday",
  "legal_holiday",
  "substitute_holiday",
  "compensatory_holiday",
  "special_holiday",
]);

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hasClockTimes(record) {
  if (record.clock_in_at || record.clock_out_at) return true;
  return (record.break_records || []).some((br) => br.clock_in_at || br.clock_out_at);
}

/**
 * Decide whether a freee work_record represents a full non-working day.
 * Half-day/hourly paid leave is intentionally not treated as a full-day skip.
 */
export function getWorkRecordNonWorkingDayStatus(record) {
  if (!record || typeof record !== "object") {
    return { isNonWorkingDay: false, reason: null, code: null };
  }

  if (record.is_absence === true) {
    return {
      isNonWorkingDay: true,
      reason: "freee work record marks the date as absence",
      code: "absence",
    };
  }

  if (record.special_holiday === true) {
    return {
      isNonWorkingDay: true,
      reason: "freee work record marks the date as special holiday",
      code: "special_holiday",
    };
  }

  const paidHolidayDays = toNumber(record.paid_holiday);
  if (paidHolidayDays >= 1) {
    return {
      isNonWorkingDay: true,
      reason: "freee work record marks the date as full-day paid holiday",
      code: "paid_holiday",
    };
  }

  const normalWorkMins = toNumber(record.normal_work_mins);
  const paidHolidayWorkMins = Math.max(
    toNumber(record.normal_work_mins_by_paid_holiday),
    toNumber(record.hourly_paid_holiday_mins),
  );

  if (normalWorkMins > 0 && paidHolidayWorkMins >= normalWorkMins) {
    return {
      isNonWorkingDay: true,
      reason: "freee work record covers normal work minutes with paid holiday",
      code: "paid_holiday_minutes",
    };
  }

  const dayPattern = String(record.day_pattern || "");
  if (NON_WORKING_DAY_PATTERNS.has(dayPattern) && !hasClockTimes(record)) {
    return {
      isNonWorkingDay: true,
      reason: `freee work record marks the date as ${dayPattern}`,
      code: "non_working_day_pattern",
    };
  }

  return { isNonWorkingDay: false, reason: null, code: null };
}
