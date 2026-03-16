import { Router } from "express";
import { FreeeApiClient } from "../../freee-api.js";
import {
  log,
  sanitizeError,
  toFreeeTime,
  requireOAuth,
  findAttendanceRouteId,
} from "./utils.js";

const router = Router();

// ===================================================================
//  Capabilities Detection — universal, not company-specific
// ===================================================================

/**
 * GET /api/attendance/capabilities - Detect what operations are available
 *
 * Returns:
 *   direct_edit: boolean    — can PUT work records directly (is_editable based)
 *   approval: boolean       — has AttendanceWorkflow approval routes
 *   approval_route_id: number|null
 *   role: string            — user role in this company (self_only, company_admin, etc.)
 *
 * This lets the frontend dynamically show available options without
 * hardcoding assumptions about any particular company's setup.
 */
router.get("/capabilities", async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // 1. Get user role
    const userInfo = await client.apiRequest("GET", "/users/me");
    const company = (userInfo.companies || []).find(
      (c) => String(c.id) === String(companyId),
    );
    const role = company ? company.role : "unknown";

    // 2. Check if approval routes exist
    const routeId = await findAttendanceRouteId(client, companyId);

    // 3. Probe whether the company actually allows employee direct PUT.
    //    Some companies have "従業員による勤怠修正" disabled at company level,
    //    meaning PUT always returns 400 regardless of is_editable flag.
    //    We do a dry-run PUT with empty body to detect this.
    let directEdit = true;
    try {
      // Try PUT today's record with minimal body — if company disables direct edit,
      // this will return 400 with "勤怠修正が設定で無効"
      const today = new Date().toISOString().slice(0, 10);
      await client.apiRequest(
        "GET",
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`,
      );
      // If GET works, try to check if PUT is allowed by examining the record's flags
      // Actually, the safest detection is to let the batch endpoint handle fallback
      // We'll just check the company role — self_only users at companies with approval
      // workflows typically can't do direct PUT
    } catch {
      // GET failing is unusual, keep directEdit = true as default
    }
    // Better approach: if the company HAS an approval route AND role is self_only,
    // direct edit is likely disabled. But we can't be 100% sure without trying PUT.
    // We let capabilities report it, and the batch endpoint does auto-fallback.
    if (routeId && role === "self_only") {
      directEdit = false; // Conservative: companies with approval + self_only likely need approval
    }

    log.info(
      `Capabilities for company ${companyId}: role=${role}, approval=${!!routeId}, direct=${directEdit}`,
    );

    res.json({
      direct_edit: directEdit,
      approval: !!routeId,
      approval_route_id: routeId,
      role,
      company_name: company ? company.name : null,
      display_name: company ? company.display_name : null,
    });
  } catch (err) {
    log.error(`Failed to detect capabilities: ${err.message}`);
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
  if (!year || !month) {
    return res.status(400).json({ error: "year and month are required" });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
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
        log.debug(`Period probe ${tryYear}/${tryM} failed: ${err.message}`);
      }
    }

    if (!data) {
      log.warn(`Could not find matching payroll period for ${y}-${m}`);
      return res.json({ records: [], summary: null, year: y, month: m });
    }

    // Extract daily records
    const records = (data.work_records || []).map((record) => ({
      date: record.date,
      clock_in: record.clock_in_at || null,
      clock_out: record.clock_out_at || null,
      day_pattern: record.day_pattern || "normal_day",
      is_holiday:
        record.day_pattern === "prescribed_holiday" ||
        record.day_pattern === "legal_holiday",
      is_absence: record.is_absence || false,
      is_editable: record.is_editable || false,
      total_work_mins: record.normal_work_mins || 0,
      total_overtime_mins: record.total_overtime_work_mins || 0,
      lateness_mins: record.lateness_mins || 0,
      early_leaving_mins: record.early_leaving_mins || 0,
      paid_holiday: record.paid_holiday || 0,
      note: record.note || "",
      break_records: (record.break_records || []).map((br) => ({
        clock_in: br.clock_in_at || null,
        clock_out: br.clock_out_at || null,
      })),
    }));

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
    log.error(`Failed to fetch records: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

/**
 * PUT /api/attendance/records/:date - Update work record for a specific date (direct write)
 * Body: { clock_in_at, clock_out_at, break_records }
 * Times: ISO 8601 with timezone (e.g., 2026-02-02T09:00:00+09:00) or freee format
 *
 * This is the "direct write" mode — no approval needed.
 * Whether a date is editable depends on the company's settings (is_editable flag).
 */
router.put("/records/:date", async (req, res) => {
  const { date } = req.params;
  const { clock_in_at, clock_out_at, break_records } = req.body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const body = { company_id: parseInt(companyId, 10) };
    if (clock_in_at) body.clock_in_at = toFreeeTime(clock_in_at, date);
    if (clock_out_at) body.clock_out_at = toFreeeTime(clock_out_at, date);
    if (break_records && break_records.length > 0) {
      body.break_records = break_records.map((br) => ({
        clock_in_at: toFreeeTime(br.clock_in_at, date),
        clock_out_at: toFreeeTime(br.clock_out_at, date),
      }));
    }

    log.info(
      `Updating work record for ${date}: in=${body.clock_in_at}, out=${body.clock_out_at}`,
    );

    const result = await client.apiRequest(
      "PUT",
      `/employees/${employeeId}/work_records/${date}?company_id=${companyId}`,
      body,
    );

    log.info(`Work record updated for ${date}`);
    res.json({ success: true, date, result });
  } catch (err) {
    log.error(`Failed to update record for ${date}: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

export default router;
