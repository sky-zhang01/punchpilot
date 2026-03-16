import { Router } from "express";
import { getSetting, setSetting, getStrategyCache, setStrategyCache, insertLog } from "../../db.js";
import { FreeeApiClient } from "../../freee-api.js";
import {
  submitLeaveRequest as submitLeaveRequestWeb,
  hasWebCredentials,
} from "../../automation/index.js";
import {
  log,
  createTask,
  updateTask,
  sanitizeError,
  requireOAuth,
  findAttendanceRouteIds,
} from "./utils.js";

const router = Router();

// ===================================================================
//  Strategy Detection — probe which strategies work for this company
// ===================================================================

/**
 * POST /api/attendance/detect-strategy - Probe which punch strategies work
 *
 * Tests each strategy against a recent work day to determine what's available.
 * Results are cached per month — re-run only on first business day or manually.
 *
 * Body: { force?: boolean } — force re-detection even if cache exists
 * Returns: { month, direct_ok, approval_ok, time_clock_ok, best_strategy, cached }
 */
router.post("/detect-strategy", async (req, res) => {
  const { force } = req.body || {};

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Check cache first (unless forced)
  if (!force) {
    const cached = getStrategyCache(currentMonth);
    if (cached) {
      log.info(
        `Strategy cache hit for ${currentMonth}: best=${cached.best_strategy}`,
      );
      return res.json({
        month: currentMonth,
        direct_ok: !!cached.direct_ok,
        approval_ok: !!cached.approval_ok,
        time_clock_ok: !!cached.time_clock_ok,
        best_strategy: cached.best_strategy,
        detected_at: cached.detected_at,
        cached: true,
        web_credentials_configured: hasWebCredentials(),
      });
    }
  }

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    let directOk = false;
    let approvalOk = false;
    let timeClockOk = false;

    // Use today for probing (GET only — no actual writes)
    const today = now.toISOString().slice(0, 10);

    // Test 1: Can we do direct PUT? — check by reading a record and seeing is_editable
    try {
      const record = await client.apiRequest(
        "GET",
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`,
      );
      // If is_editable is true AND no company-level block, direct write should work
      // We can't truly test PUT without writing, but is_editable + no restriction is a good signal
      directOk = record.is_editable !== false;
      log.info(`Strategy probe: direct edit is_editable=${record.is_editable}`);
    } catch (err) {
      log.info(
        `Strategy probe: direct read failed: ${err.message.substring(0, 100)}`,
      );
    }

    // Test 2: Do approval routes exist and are they API-compatible?
    try {
      const { primaryRouteId, fallbackRouteId } = await findAttendanceRouteIds(
        client,
        companyId,
      );
      if (primaryRouteId || fallbackRouteId) {
        // We can't truly test without submitting, but if routes exist, approval is possible
        // The batch endpoint will detect dept/position blocks at runtime
        approvalOk = true;
        log.info(
          `Strategy probe: approval routes found (primary=${primaryRouteId}, fallback=${fallbackRouteId})`,
        );
      }
    } catch (err) {
      log.info(
        `Strategy probe: approval route check failed: ${err.message.substring(0, 100)}`,
      );
    }

    // Test 3: Time clocks — check if the endpoint is accessible
    try {
      // GET time_clocks to see if the API is available (doesn't write anything)
      await client.apiRequest(
        "GET",
        `/employees/${employeeId}/time_clocks?company_id=${companyId}&limit=1`,
      );
      timeClockOk = true;
      log.info("Strategy probe: time_clocks API accessible");
    } catch (err) {
      log.info(
        `Strategy probe: time_clocks API not accessible: ${err.message.substring(0, 100)}`,
      );
    }

    // Determine best strategy
    let bestStrategy = "web"; // fallback
    if (directOk) bestStrategy = "direct";
    else if (approvalOk) bestStrategy = "approval";
    else if (timeClockOk) bestStrategy = "time_clock";

    // Cache the result
    setStrategyCache(currentMonth, {
      direct_ok: directOk,
      approval_ok: approvalOk,
      time_clock_ok: timeClockOk,
      best_strategy: bestStrategy,
    });

    log.info(
      `Strategy detection complete for ${currentMonth}: best=${bestStrategy} (direct=${directOk}, approval=${approvalOk}, time_clock=${timeClockOk})`,
    );

    res.json({
      month: currentMonth,
      direct_ok: directOk,
      approval_ok: approvalOk,
      time_clock_ok: timeClockOk,
      best_strategy: bestStrategy,
      detected_at: new Date().toISOString(),
      cached: false,
      web_credentials_configured: hasWebCredentials(),
    });
  } catch (err) {
    log.error(`Strategy detection failed: ${err.message}`);
    res.status(500).json({ error: sanitizeError(err) });
  }
});

/**
 * GET /api/attendance/strategy-cache - Get current strategy cache status
 */
router.get("/strategy-cache", (req, res) => {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const cached = getStrategyCache(currentMonth);
  res.json({
    month: currentMonth,
    cached: !!cached,
    ...(cached
      ? {
          direct_ok: !!cached.direct_ok,
          approval_ok: !!cached.approval_ok,
          time_clock_ok: !!cached.time_clock_ok,
          best_strategy: cached.best_strategy,
          detected_at: cached.detected_at,
        }
      : {}),
    web_credentials_configured: hasWebCredentials(),
  });
});

// ===================================================================
//  Leave Requests — 3-stage fallback (S1→S2→S4)
//  Similar to batch punch, but per leave/overtime type.
//  S3 (time_clocks) is not applicable for leave/overtime — only for punch.
//
//  Per-type strategy availability:
//    PaidHoliday(full):                S1(PUT work_records, paid_holiday=1) → S2 → S4
//    PaidHoliday(half/morning/afternoon): S2(POST approval_requests/paid_holidays) → S4
//    PaidHoliday(hour):                   S2(POST approval_requests/paid_holidays) → S4
//    SpecialHoliday: S1(PUT work_records) → S2(POST approval_requests/special_holidays) → S4
//    OvertimeWork:                          S2(POST approval_requests/overtime_works)  → S4
//    Absence:        S1(PUT work_records with is_absence=true)                         → S4
//    HolidayWork:                                                                        S4(Playwright only)
//
//  Strategy cache: per month+type, first success is cached as best_strategy.
//    Same month re-requests skip straight to cached best. Next month re-probes from S1/S2.
// ===================================================================

// Map leave type → approval_requests API endpoint (S2)
const LEAVE_APPROVAL_ENDPOINTS = {
  PaidHoliday: "paid_holidays",
  SpecialHoliday: "special_holidays",
  OvertimeWork: "overtime_works",
};

// Which types support S1 (direct write via PUT /work_records)
// Note: PaidHoliday S1 only supports 'full' — half/morning/afternoon/hour must use S2
//       (freee API breaking change 2024-02: paid_holiday field only accepts 1, not 0.5)
const LEAVE_DIRECT_WRITE_TYPES = ["PaidHoliday", "SpecialHoliday", "Absence"];

// Check if a leave type+subtype can use S1 direct write
function canUseS1Direct(type, holidayType) {
  if (type === "PaidHoliday") {
    // Only full-day paid holiday is supported via S1 (paid_holiday=1)
    // half/morning_off/afternoon_off/hour must go through S2 approval API
    return (holidayType || "full") === "full";
  }
  return LEAVE_DIRECT_WRITE_TYPES.includes(type);
}

// Get leave strategy cache key for a given month + type
function getLeaveStrategyCacheKey(month, type) {
  return `leave_strategy_${month}_${type}`;
}

/**
 * POST /api/attendance/leave-request - Submit a leave/overtime request
 *
 * Body: {
 *   type: 'PaidHoliday' | 'SpecialHoliday' | 'Absence' | 'HolidayWork' | 'OvertimeWork',
 *   date: 'YYYY-MM-DD',
 *   reason?: string,
 *   holiday_type?: 'full' | 'morning_off' | 'afternoon_off' | 'half' | 'hour',
 *   start_time?: 'HH:MM',   // required when holiday_type='half'/'hour' or type='OvertimeWork'
 *   end_time?: 'HH:MM',     // required when holiday_type='half'/'hour' or type='OvertimeWork'
 *   special_holiday_setting_id?: number, // required for SpecialHoliday (freee company setting ID)
 * }
 *
 * 3-stage fallback: S1(direct write) → S2(approval API) → S4(Playwright web)
 * Strategy is cached per month+type: first success becomes the fast path for that month.
 */
router.post("/leave-request", async (req, res) => {
  const { type, date, reason, holiday_type, start_time, end_time } = req.body;

  if (!type || !date) {
    return res.status(400).json({ error: "type and date are required" });
  }

  const validTypes = [
    "PaidHoliday",
    "SpecialHoliday",
    "Absence",
    "HolidayWork",
    "OvertimeWork",
  ];
  if (!validTypes.includes(type)) {
    return res
      .status(400)
      .json({ error: `Invalid leave type. Valid: ${validTypes.join(", ")}` });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  // Validate PaidHoliday subtypes
  const validHolidayTypes = [
    "full",
    "morning_off",
    "afternoon_off",
    "half",
    "hour",
  ];
  if (
    type === "PaidHoliday" &&
    holiday_type &&
    !validHolidayTypes.includes(holiday_type)
  ) {
    return res.status(400).json({
      error: `Invalid holiday_type. Valid: ${validHolidayTypes.join(", ")}`,
    });
  }

  // Validate time format when provided (HH:MM, 00-23:00-59)
  const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (start_time && !TIME_REGEX.test(start_time)) {
    return res
      .status(400)
      .json({ error: "start_time must be in HH:MM format (00:00-23:59)" });
  }
  if (end_time && !TIME_REGEX.test(end_time)) {
    return res
      .status(400)
      .json({ error: "end_time must be in HH:MM format (00:00-23:59)" });
  }

  // half/hour type requires start/end times (freee API requires start_at/end_at for both)
  if (
    type === "PaidHoliday" &&
    (holiday_type === "half" || holiday_type === "hour") &&
    (!start_time || !end_time)
  ) {
    return res.status(400).json({
      error: "start_time and end_time are required for half/hourly leave",
    });
  }

  // OvertimeWork requires start/end times
  if (type === "OvertimeWork" && (!start_time || !end_time)) {
    return res.status(400).json({
      error: "start_time and end_time are required for overtime requests",
    });
  }

  // Validate special_holiday_setting_id
  if (type === "SpecialHoliday") {
    const settingId = parseInt(req.body.special_holiday_setting_id, 10);
    if (isNaN(settingId) || settingId <= 0) {
      return res.status(400).json({
        error:
          "special_holiday_setting_id must be a positive integer for SpecialHoliday",
      });
    }
  }

  log.info(
    `Leave request: type=${type}, date=${date}, holiday_type=${holiday_type || "full"}`,
  );

  const stages = [];
  let succeeded = false;
  let result = null;

  // Check OAuth availability for S1/S2
  const oauth = (() => {
    if (getSetting("oauth_configured") !== "1") return null;
    const companyId = getSetting("oauth_company_id");
    const employeeId = getSetting("oauth_employee_id");
    if (!companyId || !employeeId) return null;
    return { companyId, employeeId };
  })();

  // --- Strategy cache: per month + type ---
  const month = date.substring(0, 7); // "YYYY-MM"
  const cacheKey = getLeaveStrategyCacheKey(month, type);
  const cachedBest = getSetting(cacheKey); // 'direct' | 'approval' | 'web' | null

  if (cachedBest) {
    log.info(
      `[${date}] Leave strategy cache hit: ${type} → ${cachedBest} for ${month}`,
    );
  }

  // FAST PATH: if cached best is 'web', skip S1/S2 entirely
  const skipApiStrategies = cachedBest === "web";

  // === Stage 1: Direct write via PUT /work_records ===
  if (
    !skipApiStrategies &&
    (!cachedBest || cachedBest === "direct") &&
    oauth &&
    canUseS1Direct(type, holiday_type)
  ) {
    try {
      const client = new FreeeApiClient();
      await client.ensureValidToken();
      const { companyId, employeeId } = oauth;

      const body = { company_id: parseInt(companyId, 10) };

      if (type === "Absence") {
        body.is_absence = true;
      } else if (type === "PaidHoliday") {
        // After freee API 2024-02 breaking change: paid_holiday only accepts 1 (full day)
        // Half/morning/afternoon/hour are handled via S2 approval API (canUseS1Direct filters these out)
        body.paid_holiday = 1;
      } else if (type === "SpecialHoliday") {
        body.special_holiday = true;
        if (req.body.special_holiday_setting_id) {
          body.special_holiday_setting_id = parseInt(
            req.body.special_holiday_setting_id,
            10,
          );
        }
      }

      await client.apiRequest(
        "PUT",
        `/employees/${employeeId}/work_records/${date}?company_id=${companyId}`,
        body,
      );

      stages.push({ stage: "S1_direct", success: true });
      log.info(`[${date}] S1 direct write succeeded for ${type}`);
      succeeded = true;
      result = { success: true, type, date, method: "direct" };
      // Cache: S1 is optimal for this month+type
      if (!cachedBest) setSetting(cacheKey, "direct");
    } catch (err) {
      stages.push({
        stage: "S1_direct",
        success: false,
        error: "Direct API write failed",
      });
      log.info(
        `[${date}] S1 direct write failed for ${type}: ${err.message?.substring(0, 120)}`,
      );
    }
  }

  // === Stage 2: Approval API (POST /approval_requests/{type}) ===
  if (
    !succeeded &&
    !skipApiStrategies &&
    oauth &&
    LEAVE_APPROVAL_ENDPOINTS[type]
  ) {
    // If cached best is 'direct' but S1 failed, still try S2 (don't skip)
    try {
      const client = new FreeeApiClient();
      await client.ensureValidToken();
      const { companyId } = oauth;

      const endpoint = LEAVE_APPROVAL_ENDPOINTS[type];
      const {
        primaryRouteId,
        fallbackRouteId,
        primaryRouteUserId,
        primaryRouteNeedsApprover,
      } = await findAttendanceRouteIds(client, companyId);
      const routeId = primaryRouteId || fallbackRouteId;

      const body = {
        company_id: parseInt(companyId, 10),
        target_date: date,
      };
      if (routeId) body.approval_flow_route_id = routeId;
      if (reason) body.comment = reason;

      // Handle approver for routes that need one
      if (primaryRouteNeedsApprover && routeId === primaryRouteId) {
        if (primaryRouteUserId) {
          body.approver_id = primaryRouteUserId;
        } else {
          try {
            const me = await client.apiRequest("GET", "/users/me");
            body.approver_id = me.id;
          } catch {
            /* ignore */
          }
        }
      }

      // Type-specific fields
      // Note: freee API uses start_at/end_at (not start_time/end_time)
      if (type === "PaidHoliday") {
        body.holiday_type = holiday_type || "full";
        // freee requires start_at/end_at for half and hour types
        if (
          (holiday_type === "half" || holiday_type === "hour") &&
          start_time &&
          end_time
        ) {
          body.start_at = start_time;
          body.end_at = end_time;
        }
      } else if (type === "OvertimeWork") {
        if (start_time) body.start_at = start_time;
        if (end_time) body.end_at = end_time;
      } else if (type === "SpecialHoliday") {
        if (req.body.special_holiday_setting_id) {
          body.special_holiday_setting_id = parseInt(
            req.body.special_holiday_setting_id,
            10,
          );
        }
        if (req.body.holiday_type) {
          body.holiday_type = req.body.holiday_type;
        }
      }

      const apiResult = await client.apiRequest(
        "POST",
        `/approval_requests/${endpoint}`,
        body,
      );

      const requestId =
        apiResult?.id || apiResult?.[endpoint.replace(/s$/, "")]?.id || null;
      stages.push({ stage: "S2_approval", success: true, id: requestId });
      log.info(
        `[${date}] S2 approval API succeeded for ${type} (id=${requestId})`,
      );
      succeeded = true;
      result = { success: true, type, date, method: "approval", id: requestId };
      // Cache: S2 is optimal for this month+type
      if (!cachedBest || cachedBest === "direct")
        setSetting(cacheKey, "approval");
    } catch (err) {
      stages.push({
        stage: "S2_approval",
        success: false,
        error: "Approval API request failed",
      });
      log.info(
        `[${date}] S2 approval API failed for ${type}: ${err.message?.substring(0, 120)}`,
      );
    }
  }

  // === Stage 4: Playwright Web automation ===
  if (!succeeded) {
    if (!hasWebCredentials()) {
      stages.push({
        stage: "S4_web",
        success: false,
        error: "web_credentials_required",
      });
      log.warn(`[${date}] S4 skipped: no web credentials`);

      // Log the attempt
      try {
        insertLog({
          action_type: "leave_request",
          scheduled_time: date,
          status: "failure",
          trigger_type: "manual",
          error_message: `type=${type} | All stages failed: ${stages.map((s) => `${s.stage}:${s.error || "ok"}`).join(", ")}`,
        });
      } catch {
        /* ignore */
      }

      return res.status(400).json({
        error:
          "All API strategies failed and freee Web credentials not configured.",
        stages,
        web_credentials_required: true,
      });
    }

    try {
      log.info(`[${date}] S4 Playwright web fallback for ${type}`);
      const webResult = await submitLeaveRequestWeb(type, date, { reason });

      if (webResult.success) {
        stages.push({ stage: "S4_web", success: true });
        log.info(`[${date}] S4 web submission succeeded for ${type}`);
        succeeded = true;
        result = { success: true, type, date, method: "web" };
        // Cache: S4 is the only working strategy for this month+type
        if (!cachedBest || cachedBest !== "web") setSetting(cacheKey, "web");
      } else {
        stages.push({
          stage: "S4_web",
          success: false,
          error: "Web automation failed",
        });
        log.error(
          `[${date}] S4 web submission failed for ${type}: ${webResult.error}`,
        );
      }
    } catch (err) {
      stages.push({
        stage: "S4_web",
        success: false,
        error: "Web automation error",
      });
      log.error(
        `[${date}] S4 web submission error for ${type}: ${err.message}`,
      );
    }
  }

  // Log the result
  try {
    insertLog({
      action_type: "leave_request",
      scheduled_time: date,
      status: succeeded ? "success" : "failure",
      trigger_type: "manual",
      error_message: succeeded
        ? `type=${type} method=${result?.method}`
        : `type=${type} | ${stages.map((s) => `${s.stage}:${s.error || "ok"}`).join(", ")}`,
    });
  } catch {
    /* ignore */
  }

  if (succeeded) {
    res.json({ ...result, stages });
  } else {
    res.status(500).json({
      error: `Leave request failed for ${type}. All strategies exhausted.`,
      stages,
    });
  }
});

/**
 * POST /api/attendance/batch-leave-request - Submit leave requests for multiple dates
 *
 * Body: {
 *   type: 'PaidHoliday' | 'SpecialHoliday' | 'Absence' | 'HolidayWork' | 'OvertimeWork',
 *   dates: ['YYYY-MM-DD', ...],
 *   reason?: string,
 *   holiday_type?: 'full' | 'morning_off' | 'afternoon_off' | 'half' | 'hour',
 *   start_time?: 'HH:MM',
 *   end_time?: 'HH:MM',
 *   special_holiday_setting_id?: number,
 * }
 *
 * Iterates over dates and reuses the same S1→S2→S4 fallback logic as single leave-request.
 */
router.post("/batch-leave-request", async (req, res) => {
  const { type, dates, reason, holiday_type, start_time, end_time } = req.body;

  if (!type || !dates || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: "type and dates array are required" });
  }
  if (dates.length > 50) {
    return res
      .status(400)
      .json({ error: "Maximum 50 dates per batch request" });
  }

  const validTypes = [
    "PaidHoliday",
    "SpecialHoliday",
    "Absence",
    "HolidayWork",
    "OvertimeWork",
  ];
  if (!validTypes.includes(type)) {
    return res
      .status(400)
      .json({ error: `Invalid leave type. Valid: ${validTypes.join(", ")}` });
  }

  // Validate all dates
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return res
        .status(400)
        .json({ error: `Invalid date format: ${d}. Use YYYY-MM-DD.` });
    }
  }

  log.info(`Batch leave request: type=${type}, ${dates.length} dates`);

  // Return task_id immediately, process in background
  const taskId = createTask("batch_leave");
  res.json({ task_id: taskId, status: "running" });

  (async () => {
    const results = [];

    for (const date of dates) {
      let succeeded = false;
      let dateResult = null;
      const stages = [];

      // Check OAuth
      const oauth = (() => {
        if (getSetting("oauth_configured") !== "1") return null;
        const companyId = getSetting("oauth_company_id");
        const employeeId = getSetting("oauth_employee_id");
        if (!companyId || !employeeId) return null;
        return { companyId, employeeId };
      })();

      // Strategy cache
      const month = date.substring(0, 7);
      const cacheKey = getLeaveStrategyCacheKey(month, type);
      const cachedBest = getSetting(cacheKey);
      const skipApiStrategies = cachedBest === "web";

      // S1: Direct write
      if (
        !skipApiStrategies &&
        (!cachedBest || cachedBest === "direct") &&
        oauth &&
        canUseS1Direct(type, holiday_type)
      ) {
        try {
          const client = new FreeeApiClient();
          await client.ensureValidToken();
          const { companyId, employeeId } = oauth;
          const body = { company_id: parseInt(companyId, 10) };

          if (type === "Absence") body.is_absence = true;
          else if (type === "PaidHoliday") body.paid_holiday = 1;
          else if (type === "SpecialHoliday") {
            body.special_holiday = true;
            if (req.body.special_holiday_setting_id)
              body.special_holiday_setting_id = parseInt(
                req.body.special_holiday_setting_id,
                10,
              );
          }

          await client.apiRequest(
            "PUT",
            `/employees/${employeeId}/work_records/${date}?company_id=${companyId}`,
            body,
          );
          stages.push({ stage: "S1_direct", success: true });
          succeeded = true;
          dateResult = { success: true, type, date, method: "direct" };
          if (!cachedBest) setSetting(cacheKey, "direct");
        } catch (err) {
          stages.push({
            stage: "S1_direct",
            success: false,
            error: err.message?.substring(0, 100),
          });
        }
      }

      // S2: Approval API
      if (
        !succeeded &&
        !skipApiStrategies &&
        oauth &&
        LEAVE_APPROVAL_ENDPOINTS[type]
      ) {
        try {
          const client = new FreeeApiClient();
          await client.ensureValidToken();
          const { companyId } = oauth;
          const endpoint = LEAVE_APPROVAL_ENDPOINTS[type];
          const {
            primaryRouteId,
            fallbackRouteId,
            primaryRouteUserId,
            primaryRouteNeedsApprover,
          } = await findAttendanceRouteIds(client, companyId);
          const routeId = primaryRouteId || fallbackRouteId;

          const body = {
            company_id: parseInt(companyId, 10),
            target_date: date,
          };
          if (routeId) body.approval_flow_route_id = routeId;
          if (reason) body.comment = reason;

          if (primaryRouteNeedsApprover && routeId === primaryRouteId) {
            if (primaryRouteUserId) body.approver_id = primaryRouteUserId;
          }

          if (type === "PaidHoliday") {
            body.holiday_type = holiday_type || "full";
            if (
              (holiday_type === "half" || holiday_type === "hour") &&
              start_time &&
              end_time
            ) {
              body.start_at = start_time;
              body.end_at = end_time;
            }
          } else if (type === "OvertimeWork") {
            if (start_time) body.start_at = start_time;
            if (end_time) body.end_at = end_time;
          } else if (type === "SpecialHoliday") {
            if (req.body.special_holiday_setting_id)
              body.special_holiday_setting_id = parseInt(
                req.body.special_holiday_setting_id,
                10,
              );
            if (req.body.holiday_type)
              body.holiday_type = req.body.holiday_type;
          }

          const apiResult = await client.apiRequest(
            "POST",
            `/approval_requests/${endpoint}`,
            body,
          );
          const requestId =
            apiResult?.id ||
            apiResult?.[endpoint.replace(/s$/, "")]?.id ||
            null;
          stages.push({ stage: "S2_approval", success: true, id: requestId });
          succeeded = true;
          dateResult = {
            success: true,
            type,
            date,
            method: "approval",
            id: requestId,
          };
          if (!cachedBest || cachedBest === "direct")
            setSetting(cacheKey, "approval");
        } catch (err) {
          stages.push({
            stage: "S2_approval",
            success: false,
            error: err.message?.substring(0, 100),
          });
        }
      }

      // S4: Playwright web
      if (!succeeded && hasWebCredentials()) {
        try {
          const webResult = await submitLeaveRequestWeb(type, date, { reason });
          if (webResult.success) {
            stages.push({ stage: "S4_web", success: true });
            succeeded = true;
            dateResult = { success: true, type, date, method: "web" };
            if (!cachedBest || cachedBest !== "web")
              setSetting(cacheKey, "web");
          } else {
            stages.push({
              stage: "S4_web",
              success: false,
              error: webResult.error,
            });
          }
        } catch (err) {
          stages.push({ stage: "S4_web", success: false, error: err.message });
        }
      }

      if (succeeded) {
        results.push({ ...dateResult, stages });
      } else {
        results.push({
          success: false,
          type,
          date,
          error: "All strategies failed",
          stages,
        });
      }

      // Brief delay between requests to avoid rate limiting
      await new Promise((r) => setTimeout(r, 300));
    }

    const succeededCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    log.info(
      `Batch leave request complete: ${succeededCount} succeeded, ${failedCount} failed`,
    );
    updateTask(taskId, {
      status: "completed",
      success: failedCount === 0,
      results,
      succeeded: succeededCount,
      failed: failedCount,
    });
  })();
});

export default router;
