import { Router } from "express";
import { FreeeApiClient } from "../../freee-api.js";
import {
  log,
  sanitizeError,
  requireOAuth,
  findAttendanceRouteIds,
} from "./utils.js";
import { safeErrorMetadata } from "../../logger.js";
import { todayStringInTz } from "../../timezone.js";
import {
  getWorkRecordLeaveCoverage,
  getWorkRecordNonWorkingDayStatus,
  isEditableWorkRecord,
} from "../../work-record-status.js";

const router = Router();

function parseYearMonth(rawYear, rawMonth) {
  if (
    !/^\d{4}$/.test(String(rawYear || "")) ||
    !/^(?:[1-9]|1[0-2])$/.test(String(rawMonth || ""))
  ) {
    return null;
  }
  const year = Number(rawYear);
  const month = Number(rawMonth);
  return year >= 2000 && year <= 2100 ? { year, month } : null;
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function mapWorkRecordForClient(record) {
  const source = record && typeof record === "object" ? record : {};
  const nonWorking = getWorkRecordNonWorkingDayStatus(source);
  const leave = getWorkRecordLeaveCoverage(source);
  const paidHolidayDays = Array.isArray(source.paid_holidays)
    ? source.paid_holidays.reduce(
      (total, entry) => total + Math.max(0, numericValue(entry?.days)),
      0,
    )
    : 0;
  const breakRecords = Array.isArray(source.break_records)
    ? source.break_records
    : [];

  return {
    date: source.date,
    clock_in: source.clock_in_at || null,
    clock_out: source.clock_out_at || null,
    day_pattern: source.day_pattern || "normal_day",
    schedule_pattern: source.schedule_pattern || "",
    is_holiday:
      source.day_pattern === "prescribed_holiday" ||
      source.day_pattern === "legal_holiday",
    is_absence: source.is_absence === true,
    is_editable: source.is_editable === true,
    is_non_working_day: nonWorking.isNonWorkingDay,
    non_working_day_code: nonWorking.code,
    has_leave: leave.hasAnyLeave,
    total_work_mins: numericValue(source.normal_work_mins),
    total_overtime_mins: numericValue(source.total_overtime_work_mins),
    lateness_mins: numericValue(source.lateness_mins),
    early_leaving_mins: numericValue(source.early_leaving_mins),
    paid_holiday: Math.max(numericValue(source.paid_holiday), paidHolidayDays),
    note: typeof source.note === "string" ? source.note : "",
    break_records: breakRecords.map((breakRecord) => ({
      clock_in: breakRecord?.clock_in_at || null,
      clock_out: breakRecord?.clock_out_at || null,
    })),
  };
}

// ===================================================================
//  Capabilities Detection — universal, not company-specific
// ===================================================================

/**
 * GET /api/attendance/capabilities - Detect what operations are available
 *
 * Returns:
 *   direct_edit: boolean    — can PUT work records directly (is_editable based)
 *   approval: boolean       — has AttendanceWorkflow approval routes
 *   approval_route_verified: boolean
 */
router.get("/capabilities", async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();

    const routeInfo = await findAttendanceRouteIds(client, companyId);
    const approval =
      routeInfo.lookupVerified &&
      !!(routeInfo.primaryRouteId || routeInfo.fallbackRouteId);
    let directEdit = false;
    try {
      const today = todayStringInTz();
      const record = await client.apiRequest(
        "GET",
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`,
      );
      directEdit = isEditableWorkRecord(record, today);
    } catch {
      directEdit = false;
    }

    log.info("Attendance capabilities detected", {
      approval,
      approvalRouteVerified: routeInfo.lookupVerified,
      directEdit,
    });

    res.json({
      direct_edit: directEdit,
      approval,
      approval_route_verified: routeInfo.lookupVerified,
    });
  } catch (err) {
    log.error("Failed to detect capabilities", {
      error: safeErrorMetadata(err),
    });
    res.status(500).json({ error: sanitizeError(err) });
  }
});

// ===================================================================
//  Records — Read & Write
// ===================================================================

/**
 * GET /api/attendance/records - Fetch monthly attendance data from freee
 * Query: year, month (calendar month)
 * Returns: { records, summary, year, month }
 *
 * Uses work_record_summaries API for a single request instead of per-day iteration.
 * The freee API uses payroll period indices which may be offset from calendar months,
 * so we probe to find the correct period matching the requested calendar month.
 */
router.get("/records", async (req, res) => {
  const { year, month } = req.query;
  const target = parseYearMonth(year, month);
  if (!target) {
    return res.status(400).json({ error: "valid year and month are required" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient({ identityBinding: oauth });
    await client.ensureValidToken();

    const { year: y, month: m } = target;
    const targetStartDate = `${y}-${String(m).padStart(2, "0")}-01`;

    log.info(
      `Fetching work_record_summaries for calendar ${y}-${String(m).padStart(2, "0")}`,
    );

    // The freee API work_record_summaries uses payroll period indices
    // which may differ from calendar months. We try multiple period indices
    // to find the one matching our target calendar month.
    let data = null;
    for (const tryMonth of [m, m + 1, m - 1, m + 2]) {
      // Handle year wrapping
      let tryYear = y;
      let tryM = tryMonth;
      if (tryM > 12) {
        tryM -= 12;
        tryYear += 1;
      }
      if (tryM < 1) {
        tryM += 12;
        tryYear -= 1;
      }

      try {
        const result = await client.apiRequest(
          "GET",
          `/employees/${employeeId}/work_record_summaries/${tryYear}/${tryM}?company_id=${companyId}&work_records=true`,
        );
        if (result.start_date === targetStartDate) {
          data = result;
          log.info(
            `Found matching period: API year=${tryYear} month=${tryM} → ${result.start_date} to ${result.end_date}`,
          );
          break;
        }
      } catch (err) {
        log.debug(`Period probe ${tryYear}/${tryM} failed`, {
          error: safeErrorMetadata(err),
        });
      }
    }

    if (!data) {
      log.warn(`Could not find matching payroll period for ${y}-${m}`);
      return res.status(502).json({ error: 'The requested payroll period could not be confirmed', code: 'WORK_RECORD_PERIOD_UNCONFIRMED' });
    }

    if (!Array.isArray(data.work_records)) {
      return res.status(502).json({ error: 'Attendance records could not be confirmed', code: 'WORK_RECORD_RESPONSE_INVALID' });
    }

    // Extract daily records
    const records = (data.work_records || []).map(mapWorkRecordForClient);

    // Extract monthly summary
    const summary = {
      work_days: data.work_days || 0,
      total_work_mins: data.total_work_mins || 0,
      total_normal_work_mins: data.total_normal_work_mins || 0,
      total_overtime_work_mins:
        (data.total_excess_statutory_work_mins || 0) +
        (data.total_overtime_except_normal_work_mins || 0) +
        (data.total_overtime_within_normal_work_mins || 0),
      total_prescribed_holiday_work_mins:
        data.total_prescribed_holiday_work_mins || 0,
      total_holiday_work_mins: data.total_holiday_work_mins || 0,
      total_latenight_work_mins: data.total_latenight_work_mins || 0,
      num_absences: data.num_absences || 0,
      num_paid_holidays: data.num_paid_holidays || 0,
      num_paid_holidays_left: data.num_paid_holidays_left || 0,
      num_paid_holidays_and_hours: data.num_paid_holidays_and_hours || {
        days: 0,
        hours: 0,
      },
      num_paid_holidays_and_hours_left:
        data.num_paid_holidays_and_hours_left || { days: 0, hours: 0 },
      total_lateness_and_early_leaving_mins:
        data.total_lateness_and_early_leaving_mins || 0,
    };

    const withClockIn = records.filter((r) => r.clock_in).length;
    log.info(
      `Fetched ${records.length} records, ${withClockIn} with clock-in data, summary: ${summary.work_days} work days`,
    );

    res.json({ records, summary, year: y, month: m });
  } catch (err) {
    log.error("Failed to fetch records", { error: safeErrorMetadata(err) });
    res.status(500).json({ error: sanitizeError(err) });
  }
});

export default router;
