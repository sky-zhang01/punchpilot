import { Router } from 'express';
import { getSetting, setSetting, getStrategyCache, setStrategyCache, insertLog } from '../db.js';
import { FreeeApiClient } from '../freee-api.js';
import { submitWebCorrections, hasWebCredentials, scrapeEmployeeProfile, submitLeaveRequest } from '../automation.js';
import logger from '../logger.js';

const router = Router();
const log = logger.child('Attendance');

/**
 * Convert ISO 8601 or any datetime string to freee API format: "YYYY-MM-DD HH:MM:SS"
 * Input examples: "2026-02-03T10:00:00+09:00", "2026-02-03T10:00:00"
 * Output: "2026-02-03 10:00:00"
 */
function toFreeeTime(isoStr, datePrefix) {
  if (!isoStr) return null;
  // Already in freee format "YYYY-MM-DD HH:MM:SS"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(isoStr)) return isoStr;
  // ISO 8601 → extract date and time parts
  const match = isoStr.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  if (match) {
    const time = match[2].length === 5 ? `${match[2]}:00` : match[2];
    return `${match[1]} ${time}`;
  }
  // Time-only input "HH:MM" or "HH:MM:SS" — prepend date if provided
  if (datePrefix && /^\d{2}:\d{2}(:\d{2})?$/.test(isoStr)) {
    const time = isoStr.length === 5 ? `${isoStr}:00` : isoStr;
    return `${datePrefix} ${time}`;
  }
  return isoStr;
}

/**
 * Extract time-only portion "HH:MM" from any datetime format.
 * Used by the approval API which requires "HH:MM" or "HH:MM:SS" format.
 *
 * Input examples:
 *   "2026-02-03T10:00:00+09:00" → "10:00"
 *   "2026-02-03 10:00:00"       → "10:00"
 *   "10:00"                     → "10:00"
 *   "10:00:00"                  → "10:00"
 */
function toTimeOnly(isoStr) {
  if (!isoStr) return null;
  // Already time-only "HH:MM" or "HH:MM:SS"
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(isoStr)) return isoStr.substring(0, 5);
  // ISO 8601 or freee format — extract HH:MM
  const match = isoStr.match(/[T ](\d{2}:\d{2})/);
  if (match) return match[1];
  return isoStr;
}

/**
 * Helper: Validate OAuth is configured and return companyId + employeeId
 */
function requireOAuth(res) {
  if (getSetting('oauth_configured') !== '1') {
    res.status(400).json({ error: 'OAuth not configured. Go to Settings to configure API (OAuth2).' });
    return null;
  }
  const companyId = getSetting('oauth_company_id');
  const employeeId = getSetting('oauth_employee_id');
  if (!companyId) {
    res.status(400).json({ error: 'Company not selected. Go to Settings to select a company.', code: 'COMPANY_NOT_SELECTED' });
    return null;
  }
  if (!employeeId) {
    res.status(400).json({ error: 'Employee record not found for this company. Please add an employee record in freee HR admin first.', code: 'EMPLOYEE_NOT_FOUND' });
    return null;
  }
  return { companyId, employeeId };
}

/**
 * Helper: Find approval routes for attendance workflow.
 * Returns { primaryRouteId, fallbackRouteId } where:
 *   - primaryRouteId: the AttendanceWorkflow-specific route (may use dept/position conditions)
 *   - fallbackRouteId: a system-defined route without dept/position conditions ("指定なし")
 *
 * Some companies configure AttendanceWorkflow routes with dept/position-based approvers,
 * which the freee API doesn't support (returns "役職、部門を利用する申請はWebから申請してください").
 * In that case, we fall back to the generic system route.
 */
async function findAttendanceRouteIds(client, companyId) {
  try {
    const data = await client.apiRequest(
      'GET',
      `/approval_flow_routes?company_id=${companyId}`
    );
    const routes = data.approval_flow_routes || [];

    // Primary: route specifically configured for AttendanceWorkflow
    const attendanceRoute = routes.find(r =>
      r.usages && r.usages.includes('AttendanceWorkflow')
    );
    const primaryRouteId = attendanceRoute ? attendanceRoute.id : null;
    const primaryRouteUserId = attendanceRoute ? attendanceRoute.user_id : null;
    // Some routes require specifying an approver (e.g. "承認者を指定" type routes)
    const primaryRouteNeedsApprover = attendanceRoute
      ? (attendanceRoute.name || '').includes('指定') && !attendanceRoute.user_id
      : false;

    // Fallback: system-defined route with no usage restrictions (typically "指定なし")
    const systemRoute = routes.find(r =>
      r.definition_system === true && (!r.usages || r.usages.length === 0)
    );
    const fallbackRouteId = systemRoute ? systemRoute.id : null;

    return { primaryRouteId, fallbackRouteId, primaryRouteUserId, primaryRouteNeedsApprover };
  } catch {
    return { primaryRouteId: null, fallbackRouteId: null, primaryRouteUserId: null, primaryRouteNeedsApprover: false };
  }
}

// Backward compat wrapper — returns the best single route ID
async function findAttendanceRouteId(client, companyId) {
  const { primaryRouteId, fallbackRouteId } = await findAttendanceRouteIds(client, companyId);
  return primaryRouteId || fallbackRouteId || null;
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
 *   approval_route_id: number|null
 *   role: string            — user role in this company (self_only, company_admin, etc.)
 *
 * This lets the frontend dynamically show available options without
 * hardcoding assumptions about any particular company's setup.
 */
router.get('/capabilities', async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // 1. Get user role
    const userInfo = await client.apiRequest('GET', '/users/me');
    const company = (userInfo.companies || []).find(c => String(c.id) === String(companyId));
    const role = company ? company.role : 'unknown';

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
        'GET',
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`
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
    if (routeId && role === 'self_only') {
      directEdit = false; // Conservative: companies with approval + self_only likely need approval
    }

    log.info(`Capabilities for company ${companyId}: role=${role}, approval=${!!routeId}, direct=${directEdit}`);

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
    res.status(500).json({ error: err.message });
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
router.get('/records', async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: 'year and month are required' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const targetStartDate = `${y}-${String(m).padStart(2, '0')}-01`;

    log.info(`Fetching work_record_summaries for calendar ${y}-${String(m).padStart(2, '0')}`);

    // The freee API work_record_summaries uses payroll period indices
    // which may differ from calendar months. We try multiple period indices
    // to find the one matching our target calendar month.
    let data = null;
    for (const tryMonth of [m, m + 1, m - 1, m + 2]) {
      // Handle year wrapping
      let tryYear = y;
      let tryM = tryMonth;
      if (tryM > 12) { tryM -= 12; tryYear += 1; }
      if (tryM < 1) { tryM += 12; tryYear -= 1; }

      try {
        const result = await client.apiRequest(
          'GET',
          `/employees/${employeeId}/work_record_summaries/${tryYear}/${tryM}?company_id=${companyId}&work_records=true`
        );
        if (result.start_date === targetStartDate) {
          data = result;
          log.info(`Found matching period: API year=${tryYear} month=${tryM} → ${result.start_date} to ${result.end_date}`);
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
    const records = (data.work_records || []).map(record => ({
      date: record.date,
      clock_in: record.clock_in_at || null,
      clock_out: record.clock_out_at || null,
      day_pattern: record.day_pattern || 'normal_day',
      is_holiday: record.day_pattern === 'prescribed_holiday' || record.day_pattern === 'legal_holiday',
      is_absence: record.is_absence || false,
      is_editable: record.is_editable || false,
      total_work_mins: record.normal_work_mins || 0,
      total_overtime_mins: record.total_overtime_work_mins || 0,
      lateness_mins: record.lateness_mins || 0,
      early_leaving_mins: record.early_leaving_mins || 0,
      paid_holiday: record.paid_holiday || 0,
      note: record.note || '',
      break_records: (record.break_records || []).map(br => ({
        clock_in: br.clock_in_at || null,
        clock_out: br.clock_out_at || null,
      })),
    }));

    // Extract monthly summary
    const summary = {
      work_days: data.work_days || 0,
      total_work_mins: data.total_work_mins || 0,
      total_normal_work_mins: data.total_normal_work_mins || 0,
      total_overtime_work_mins: (data.total_excess_statutory_work_mins || 0)
        + (data.total_overtime_except_normal_work_mins || 0)
        + (data.total_overtime_within_normal_work_mins || 0),
      total_prescribed_holiday_work_mins: data.total_prescribed_holiday_work_mins || 0,
      total_holiday_work_mins: data.total_holiday_work_mins || 0,
      total_latenight_work_mins: data.total_latenight_work_mins || 0,
      num_absences: data.num_absences || 0,
      num_paid_holidays: data.num_paid_holidays || 0,
      num_paid_holidays_left: data.num_paid_holidays_left || 0,
      num_paid_holidays_and_hours: data.num_paid_holidays_and_hours || { days: 0, hours: 0 },
      num_paid_holidays_and_hours_left: data.num_paid_holidays_and_hours_left || { days: 0, hours: 0 },
      total_lateness_and_early_leaving_mins: data.total_lateness_and_early_leaving_mins || 0,
    };

    const withClockIn = records.filter(r => r.clock_in).length;
    log.info(`Fetched ${records.length} records, ${withClockIn} with clock-in data, summary: ${summary.work_days} work days`);

    res.json({ records, summary, year: y, month: m });
  } catch (err) {
    log.error(`Failed to fetch records: ${err.message}`);
    res.status(500).json({ error: err.message });
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
router.put('/records/:date', async (req, res) => {
  const { date } = req.params;
  const { clock_in_at, clock_out_at, break_records } = req.body;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
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
      body.break_records = break_records.map(br => ({
        clock_in_at: toFreeeTime(br.clock_in_at, date),
        clock_out_at: toFreeeTime(br.clock_out_at, date),
      }));
    }

    log.info(`Updating work record for ${date}: in=${body.clock_in_at}, out=${body.clock_out_at}`);

    const result = await client.apiRequest(
      'PUT',
      `/employees/${employeeId}/work_records/${date}?company_id=${companyId}`,
      body
    );

    log.info(`Work record updated for ${date}`);
    res.json({ success: true, date, result });
  } catch (err) {
    log.error(`Failed to update record for ${date}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ===================================================================
//  Batch Operations — smart endpoint, auto-decides strategy per date
// ===================================================================

/**
 * POST /api/attendance/batch - Smart batch punch for multiple dates
 *
 * Body: {
 *   entries: [{ date, clock_in_at, clock_out_at, break_records?, is_editable? }],
 *   reason?: string  (used as comment when submitting approval requests)
 * }
 *
 * The server automatically decides per-date:
 *   - is_editable=true  → PUT /work_records (direct write, no approval)
 *   - is_editable=false → POST /approval_requests/work_times (needs approval)
 *   - No approval route → always try PUT regardless
 *
 * The frontend just sends dates + times. The backend handles the rest.
 * This is the user's one-click "batch punch" — they don't need to know
 * whether it's a direct write or an approval request.
 */
router.post('/batch', async (req, res) => {
  const { entries, reason } = req.body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries array is required and must not be empty' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // Probe once: does this company have approval workflows?
    const { primaryRouteId, fallbackRouteId, primaryRouteUserId, primaryRouteNeedsApprover } = await findAttendanceRouteIds(client, companyId);
    const routeId = primaryRouteId || fallbackRouteId;
    const hasApproval = !!routeId;

    // Get current user ID for self-approval (needed when route requires approver specification)
    let selfUserId = null;
    if (primaryRouteNeedsApprover) {
      try {
        const me = await client.apiRequest('GET', '/users/me');
        selfUserId = me.id;
      } catch { /* ignore */ }
    }

    // Helper: build the approval request body
    function buildApprovalBody(entry, useRouteId) {
      const body = {
        company_id: parseInt(companyId, 10),
        target_date: entry.date,
        approval_flow_route_id: useRouteId,
      };

      // Some routes require specifying an approver (e.g. "承認者を指定" type)
      // Use the route's configured user_id, or fall back to self (admin can self-approve)
      if (primaryRouteNeedsApprover && useRouteId === primaryRouteId) {
        body.approver_id = primaryRouteUserId || selfUserId;
      }

      // work_records: array of { clock_in_at, clock_out_at } in "HH:MM" format
      if (entry.clock_in_at || entry.clock_out_at) {
        const workRecord = {};
        if (entry.clock_in_at) workRecord.clock_in_at = toTimeOnly(entry.clock_in_at);
        if (entry.clock_out_at) workRecord.clock_out_at = toTimeOnly(entry.clock_out_at);
        body.work_records = [workRecord];
      }

      // break_records: top-level array of { clock_in_at, clock_out_at } in "HH:MM" format
      if (entry.break_records && entry.break_records.length > 0) {
        body.break_records = entry.break_records.map(br => ({
          clock_in_at: toTimeOnly(br.clock_in_at),
          clock_out_at: toTimeOnly(br.clock_out_at),
        }));
      }

      if (reason) body.comment = reason;
      return body;
    }

    // Helper: submit one entry via approval request
    async function submitApproval(entry) {
      const body = buildApprovalBody(entry, primaryRouteId || fallbackRouteId);
      return await client.apiRequest('POST', '/approval_requests/work_times', body);
    }

    // Helper: submit one entry via time_clocks (打刻 API)
    // Sends sequential clock_in → break_begin → break_end → clock_out punches.
    // For self_only users, datetime cannot be specified — only works for "now" punching.
    // Past dates will fail with permission error; we catch and give a clear message.
    async function submitTimeClock(entry) {
      const cid = parseInt(companyId, 10);
      const punches = [];

      if (entry.clock_in_at) {
        punches.push({ type: 'clock_in', datetime: toFreeeTime(entry.clock_in_at), base_date: entry.date });
      }
      if (entry.break_records && entry.break_records.length > 0) {
        for (const br of entry.break_records) {
          if (br.clock_in_at) punches.push({ type: 'break_begin', datetime: toFreeeTime(br.clock_in_at), base_date: entry.date });
          if (br.clock_out_at) punches.push({ type: 'break_end', datetime: toFreeeTime(br.clock_out_at), base_date: entry.date });
        }
      }
      if (entry.clock_out_at) {
        punches.push({ type: 'clock_out', datetime: toFreeeTime(entry.clock_out_at), base_date: entry.date });
      }

      for (const punch of punches) {
        await client.apiRequest('POST', `/employees/${employeeId}/time_clocks`, { company_id: cid, ...punch });
        await new Promise(r => setTimeout(r, 200));
      }
      return { method: 'time_clock', punches: punches.length };
    }

    // Track which strategies have failed at company level
    let approvalRouteBlocked = false;

    // Check strategy cache for this month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const cachedStrategy = getStrategyCache(currentMonth);

    log.info(`Batch: ${entries.length} entries, approval=${hasApproval}${routeId ? ` (route=${routeId})` : ''}${cachedStrategy ? `, cached_best=${cachedStrategy.best_strategy}` : ''}`);

    const results = [];
    let webFallbackEntries = [];  // Entries that need Strategy 4 (web fallback)
    // Company-level strategy detection: once a strategy fails for company-wide reasons,
    // skip it for all remaining entries. Pre-seed from cache if available.
    let directDisabled = cachedStrategy ? !cachedStrategy.direct_ok : false;
    if (cachedStrategy && !cachedStrategy.approval_ok) approvalRouteBlocked = true;

    // FAST PATH: If cached best strategy is 'web', skip API strategies 1-3 entirely
    const skipApiStrategies = cachedStrategy?.best_strategy === 'web';
    if (skipApiStrategies) {
      log.info(`Cached best=web → skipping API strategies 1-3, sending all ${entries.length} entries directly to Strategy 4`);
      webFallbackEntries = [...entries];
    }

    // Process each entry with 3-tier auto-fallback (skipped if cached best=web):
    //   1. PUT /work_records (direct write) — fastest, no approval needed
    //   2. POST /approval_requests/work_times (approval) — needs approval route
    //   3. POST /time_clocks (clock punches) — last resort, simulates real-time clocking
    for (let i = 0; !skipApiStrategies && i < entries.length; i++) {
      const entry = entries[i];

      // Refresh token periodically for large batches to avoid expiry mid-operation
      if (i > 0 && i % 10 === 0) {
        try { await client.ensureValidToken(); } catch (e) { log.warn(`Token refresh at entry ${i}: ${e.message}`); }
      }
      let succeeded = false;
      const editable = entry.is_editable !== undefined ? entry.is_editable : true;

      // === Strategy 1: Direct PUT ===
      if (!directDisabled && (editable || !hasApproval)) {
        try {
          const body = { company_id: parseInt(companyId, 10) };
          if (entry.clock_in_at) body.clock_in_at = toFreeeTime(entry.clock_in_at);
          if (entry.clock_out_at) body.clock_out_at = toFreeeTime(entry.clock_out_at);
          if (entry.break_records && entry.break_records.length > 0) {
            body.break_records = entry.break_records.map(br => ({
              clock_in_at: toFreeeTime(br.clock_in_at),
              clock_out_at: toFreeeTime(br.clock_out_at),
            }));
          }
          await client.apiRequest('PUT', `/employees/${employeeId}/work_records/${entry.date}?company_id=${companyId}`, body);
          results.push({ date: entry.date, success: true, method: 'direct' });
          log.info(`[${entry.date}] Direct write succeeded`);
          succeeded = true;
        } catch (err) {
          const errMsg = err.message || '';
          if (errMsg.includes('勤怠修正') || errMsg.includes('無効')) {
            directDisabled = true;
            log.info(`[${entry.date}] Direct write disabled at company level, trying next strategy`);
          } else {
            log.warn(`[${entry.date}] Direct write failed: ${errMsg.substring(0, 120)}`);
          }
        }
      }

      // === Strategy 2: Approval request ===
      if (!succeeded && hasApproval && !approvalRouteBlocked) {
        try {
          const result = await submitApproval(entry);
          results.push({ date: entry.date, success: true, method: 'approval', id: result.id || null });
          log.info(`[${entry.date}] Approval request succeeded`);
          succeeded = true;
        } catch (err) {
          const errMsg = err.message || '';
          if (errMsg.includes('役職') || errMsg.includes('部門')) {
            approvalRouteBlocked = true;
            log.info(`[${entry.date}] Approval route uses dept/position (unsupported by API), trying time_clocks`);
          } else {
            log.warn(`[${entry.date}] Approval request failed: ${errMsg.substring(0, 120)}`);
          }
        }
      }

      // === Strategy 3: Time clocks (打刻 API) ===
      if (!succeeded) {
        try {
          await submitTimeClock(entry);
          results.push({ date: entry.date, success: true, method: 'time_clock' });
          log.info(`[${entry.date}] Time clock punches succeeded`);
          succeeded = true;
        } catch (err) {
          const errMsg = err.message || '';
          // Collect for Strategy 4 (web fallback)
          webFallbackEntries.push(entry);
          log.warn(`[${entry.date}] API strategies 1-3 all failed. Last error: ${errMsg.substring(0, 150)}`);
        }
      }

      await new Promise(r => setTimeout(r, 200));
    }

    // === Strategy 4: Playwright Web fallback ===
    // For entries where all API strategies failed, try submitting via freee Web form
    if (webFallbackEntries.length > 0 && hasWebCredentials()) {
      log.info(`Strategy 4: Attempting ${webFallbackEntries.length} entries via freee Web (Playwright)...`);
      try {
        const webResults = await submitWebCorrections(webFallbackEntries, reason || '打刻漏れのため修正');
        for (const wr of webResults) {
          results.push(wr);
          if (wr.success) {
            log.info(`[${wr.date}] Web correction succeeded`);
          } else {
            log.error(`[${wr.date}] Web correction failed: ${wr.error}`);
          }
        }
      } catch (err) {
        log.error(`Strategy 4 (Web) failed entirely: ${err.message}`);
        for (const entry of webFallbackEntries) {
          results.push({ date: entry.date, success: false, method: 'all_failed', error: `Web fallback error: ${err.message}` });
        }
      }
    } else if (webFallbackEntries.length > 0) {
      // No web credentials — report as freee_web_required so frontend shows setup prompt
      log.warn(`Strategy 4 skipped: ${webFallbackEntries.length} entries need web credentials`);
      for (const entry of webFallbackEntries) {
        results.push({
          date: entry.date,
          success: false,
          method: 'all_failed',
          error: 'web_credentials_required',
        });
      }
    }

    // Update strategy cache based on what we learned during this batch
    const methodsUsed = results.map(r => r.method);
    const newCacheData = {
      direct_ok: !directDisabled,
      approval_ok: !approvalRouteBlocked && hasApproval,
      time_clock_ok: methodsUsed.includes('time_clock') || (cachedStrategy ? !!cachedStrategy.time_clock_ok : true),
      best_strategy: directDisabled ? (approvalRouteBlocked ? (hasWebCredentials() ? 'web' : 'time_clock') : 'approval') : 'direct',
    };
    setStrategyCache(currentMonth, newCacheData);

    const succeededCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const methods = {};
    for (const r of results) { methods[r.method] = (methods[r.method] || 0) + 1; }
    log.info(`Batch complete: ${succeededCount}/${results.length} succeeded (${JSON.stringify(methods)})`);

    // Log each batch result to execution_log for audit trail
    for (const r of results) {
      try {
        insertLog({
          action_type: 'batch_correction',
          scheduled_time: r.date,
          status: r.success ? 'success' : 'failure',
          trigger_type: 'batch',
          error_message: r.success
            ? `method=${r.method}`
            : `method=${r.method} | ${r.error || 'Unknown error'}`,
        });
      } catch (logErr) {
        log.warn(`Failed to write batch log for ${r.date}: ${logErr.message}`);
      }
    }

    // Include strategy info for frontend
    const webCredsInvalid = results.some(r => r.error === 'web_credentials_invalid');
    const strategyInfo = {
      direct_disabled: directDisabled,
      approval_route_blocked: approvalRouteBlocked,
      web_fallback_used: webFallbackEntries.length > 0 && hasWebCredentials(),
      web_credentials_configured: hasWebCredentials(),
      web_credentials_invalid: webCredsInvalid,
    };

    res.json({ success: failedCount === 0, results, succeeded: succeededCount, failed: failedCount, strategy_info: strategyInfo });
  } catch (err) {
    log.error(`Batch failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ===================================================================
//  Approval Requests — individual operations (kept for single-use)
// ===================================================================

/**
 * GET /api/attendance/approval-routes - Get available approval flow routes
 */
router.get('/approval-routes', async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const data = await client.apiRequest(
      'GET',
      `/approval_flow_routes?company_id=${companyId}`
    );

    const routes = data.approval_flow_routes || [];
    const attendanceRoute = routes.find(r =>
      r.usages && r.usages.includes('AttendanceWorkflow')
    );

    res.json({
      routes,
      attendance_route_id: attendanceRoute ? attendanceRoute.id : null,
      attendance_route_name: attendanceRoute ? attendanceRoute.name : null,
    });
  } catch (err) {
    log.error(`Failed to fetch approval routes: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/attendance/employee-info - Get employee info from freee
 * Returns whatever data is accessible with current permissions
 */
router.get('/employee-info', async (req, res) => {
  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // /users/me always works
    const userInfo = await client.apiRequest('GET', '/users/me');
    const company = (userInfo.companies || []).find(c => String(c.id) === String(companyId));

    const result = {
      user_id: userInfo.id,
      employee_id: parseInt(employeeId, 10),
      company_id: parseInt(companyId, 10),
      company_name: company ? company.name : null,
      display_name: company ? company.display_name : null,
      role: company ? company.role : null,
      // Fields from /employees/{id} — requires elevated permissions
      num: null,
      entry_date: null,
      retire_date: null,
      employment_type: null,
      title: null,
      birth_date: null,
    };

    // Try to get detailed employee info (may fail with self_only role)
    try {
      const empData = await client.apiRequest(
        'GET',
        `/employees/${employeeId}?company_id=${companyId}&year=${new Date().getFullYear()}&month=${new Date().getMonth() + 1}`
      );
      if (empData) {
        result.num = empData.num || null;
        result.entry_date = empData.entry_date || null;
        result.retire_date = empData.retire_date || null;
        result.birth_date = empData.birth_date || null;
        if (empData.profile_rule) {
          result.employment_type = empData.profile_rule.employment_type || null;
          result.title = empData.profile_rule.title || null;
        }
      }
    } catch (empErr) {
      log.info(`Employee detail API not accessible (role=${result.role}): ${empErr.message.substring(0, 100)}`);

      // Fallback: try to use cached data or web scraping
      const forceRefresh = req.query.force === 'true';
      const cacheDate = getSetting('employee_info_cache_date');
      const cacheData = getSetting('employee_info_cache');
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      if (!forceRefresh && cacheDate === currentMonth && cacheData) {
        // Use cached data
        try {
          const cached = JSON.parse(cacheData);
          result.name = cached.name || null;
          result.department = cached.department || null;
          result.position = cached.position || null;
          result.employment_type = cached.employment_type || null;
          result.entry_date = cached.entry_date || null;
          result.num = cached.employee_num || null;
          result.data_source = 'cache';
          log.info('Using cached employee info from web scraping');
        } catch { /* ignore parse errors */ }
      } else if (hasWebCredentials()) {
        // Try web scraping
        try {
          log.info(`Attempting employee info web scraping (employeeId=${employeeId})`);
          const webInfo = await scrapeEmployeeProfile(employeeId);
          if (webInfo) {
            result.name = webInfo.name || null;
            result.department = webInfo.department || null;
            result.position = webInfo.position || null;
            result.employment_type = webInfo.employment_type || null;
            result.entry_date = webInfo.entry_date || null;
            result.num = webInfo.employee_num || null;
            result.data_source = 'web';

            // Cache the result
            setSetting('employee_info_cache', JSON.stringify(webInfo));
            setSetting('employee_info_cache_date', currentMonth);
            log.info('Employee info scraped from web and cached');
          }
        } catch (webErr) {
          log.warn(`Employee info web scraping failed: ${webErr.message.substring(0, 100)}`);
        }
      }
    }

    res.json(result);
  } catch (err) {
    log.error(`Failed to fetch employee info: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/attendance/approval/monthly - Submit monthly attendance closing request
 * Body: { year, month }
 */
router.post('/approval/monthly', async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) {
    return res.status(400).json({ error: 'year and month are required' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const routeId = await findAttendanceRouteId(client, companyId);

    const targetDate = `${year}-${String(month).padStart(2, '0')}-01`;
    log.info(`Submitting monthly attendance closing for ${targetDate} (route=${routeId})`);

    const body = {
      company_id: parseInt(companyId, 10),
      target_date: targetDate,
    };
    if (routeId) body.approval_flow_route_id = routeId;

    const result = await client.apiRequest(
      'POST',
      '/approval_requests/monthly_attendances',
      body
    );

    log.info('Monthly attendance closing request submitted');

    try {
      insertLog({
        action_type: 'monthly_closing',
        scheduled_time: targetDate,
        status: 'success',
        trigger_type: 'manual',
      });
    } catch (logErr) { /* ignore */ }

    res.json({ success: true, result });
  } catch (err) {
    log.error(`Monthly closing failed: ${err.message}`);

    try {
      insertLog({
        action_type: 'monthly_closing',
        scheduled_time: `${year}-${String(month).padStart(2, '0')}-01`,
        status: 'failure',
        trigger_type: 'manual',
        error_message: err.message?.substring(0, 300),
      });
    } catch (logErr) { /* ignore */ }

    const status = err.message.includes('403') || err.message.includes('402') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/attendance/approval/work-time - Submit single work time correction request
 * Body: { date, clock_in_at, clock_out_at, break_records, reason }
 */
router.post('/approval/work-time', async (req, res) => {
  const { date, clock_in_at, clock_out_at, break_records, reason } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const { primaryRouteId, fallbackRouteId, primaryRouteUserId, primaryRouteNeedsApprover } = await findAttendanceRouteIds(client, companyId);
    const routeId = primaryRouteId || fallbackRouteId;

    log.info(`Submitting work time correction for ${date} (route=${routeId}, needsApprover=${primaryRouteNeedsApprover})`);

    const body = {
      company_id: parseInt(companyId, 10),
      target_date: date,
    };
    if (routeId) body.approval_flow_route_id = routeId;

    // Some routes require specifying an approver (e.g. "承認者を指定" type)
    if (primaryRouteNeedsApprover && routeId === primaryRouteId) {
      if (primaryRouteUserId) {
        body.approver_id = primaryRouteUserId;
      } else {
        // Fall back to self (admin users can self-approve)
        try {
          const me = await client.apiRequest('GET', '/users/me');
          body.approver_id = me.id;
        } catch { /* ignore */ }
      }
    }

    // Approval API uses work_records array with time-only "HH:MM" format
    if (clock_in_at || clock_out_at) {
      const workRecord = {};
      if (clock_in_at) workRecord.clock_in_at = toTimeOnly(clock_in_at);
      if (clock_out_at) workRecord.clock_out_at = toTimeOnly(clock_out_at);
      body.work_records = [workRecord];
    }
    if (break_records && break_records.length > 0) {
      body.break_records = break_records.map(br => ({
        clock_in_at: toTimeOnly(br.clock_in_at),
        clock_out_at: toTimeOnly(br.clock_out_at),
      }));
    }
    if (reason) body.comment = reason;

    const result = await client.apiRequest(
      'POST',
      '/approval_requests/work_times',
      body
    );

    const requestId = result?.work_time?.id || result?.id || null;
    log.info(`Work time correction request submitted (id=${requestId})`);

    try {
      insertLog({
        action_type: 'approval_submitted',
        scheduled_time: date,
        status: 'success',
        trigger_type: 'manual',
        error_message: `id=${requestId}`,
      });
    } catch (logErr) { /* ignore log failures */ }

    res.json({ success: true, id: requestId, result });
  } catch (err) {
    log.error(`Work time correction failed: ${err.message}`);

    try {
      insertLog({
        action_type: 'approval_submitted',
        scheduled_time: req.body.date,
        status: 'failure',
        trigger_type: 'manual',
        error_message: err.message?.substring(0, 300),
      });
    } catch (logErr) { /* ignore log failures */ }

    const status = err.message.includes('403') || err.message.includes('402') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ===================================================================
//  Approval Request Tracking — list, view, withdraw
// ===================================================================

/**
 * GET /api/attendance/approval-requests - Fetch work time approval requests
 * Query: year, month (calendar month)
 * Returns: { requests: [{ id, status, target_date, work_records, break_records, comment, created_at }] }
 *
 * Queries freee API for work_time approval requests across statuses:
 * in_progress (pending), approved, feedback (rejected)
 */
router.get('/approval-requests', async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: 'year and month are required' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const monthPrefix = `${y}-${String(m).padStart(2, '0')}`;

    const allRequests = [];
    const statuses = ['in_progress', 'approved', 'feedback'];

    for (const status of statuses) {
      try {
        const data = await client.apiRequest(
          'GET',
          `/approval_requests/work_times?company_id=${companyId}&status=${status}`
        );
        // freee API returns work_times array (not approval_requests)
        const requests = data.work_times || data.approval_requests || [];
        for (const req of requests) {
          // Filter to target month
          if (req.target_date && req.target_date.startsWith(monthPrefix)) {
            allRequests.push({
              id: req.id,
              status: req.status || status,
              target_date: req.target_date,
              work_records: (req.work_records || []).map(wr => ({
                clock_in_at: wr.clock_in_at || null,
                clock_out_at: wr.clock_out_at || null,
              })),
              break_records: (req.break_records || []).map(br => ({
                clock_in_at: br.clock_in_at || null,
                clock_out_at: br.clock_out_at || null,
              })),
              comment: req.comment || '',
              request_number: req.application_number ? String(req.application_number) : null,
              created_at: req.issue_date || null,
            });
          }
        }
      } catch (err) {
        log.warn(`Failed to fetch approval requests with status=${status}: ${err.message.substring(0, 100)}`);
      }
    }

    log.info(`Fetched ${allRequests.length} approval requests for ${monthPrefix}`);
    res.json({ requests: allRequests });
  } catch (err) {
    log.error(`Failed to fetch approval requests: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/attendance/approval-requests/:id - Withdraw/cancel an approval request
 *
 * freee API behavior:
 *   - DELETE only works for draft/pending requests, NOT in_progress ones
 *   - For in_progress requests, use POST /actions with { approval_action: 'cancel' }
 *   - We try cancel first, then fall back to DELETE
 */
router.delete('/approval-requests/:id', async (req, res) => {
  const { id } = req.params;

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    // First, try to get the request details to know its current state
    let requestData;
    try {
      requestData = await client.apiRequest(
        'GET',
        `/approval_requests/work_times/${id}?company_id=${companyId}`
      );
    } catch { /* ignore, proceed with cancel attempt */ }

    const currentStep = requestData?.work_time?.current_step_id;
    const currentRound = requestData?.work_time?.current_round || 1;

    // Try cancel action first (works for in_progress requests)
    try {
      const cancelBody = {
        approval_action: 'cancel',
        target_round: currentRound,
        target_step_id: currentStep,
      };
      await client.apiRequest(
        'POST',
        `/approval_requests/work_times/${id}/actions?company_id=${companyId}`,
        cancelBody
      );
      log.info(`Approval request ${id} cancelled via action`);
      return res.json({ success: true, id: parseInt(id, 10), method: 'cancel' });
    } catch (cancelErr) {
      log.info(`Cancel action failed for ${id}: ${cancelErr.message}, trying DELETE...`);
    }

    // Fallback: try DELETE (works for draft/pending requests)
    await client.apiRequest(
      'DELETE',
      `/approval_requests/work_times/${id}?company_id=${companyId}`
    );

    log.info(`Approval request ${id} withdrawn via DELETE`);
    res.json({ success: true, id: parseInt(id, 10), method: 'delete' });
  } catch (err) {
    log.error(`Failed to withdraw approval request ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

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
router.post('/detect-strategy', async (req, res) => {
  const { force } = req.body || {};

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId, employeeId } = oauth;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Check cache first (unless forced)
  if (!force) {
    const cached = getStrategyCache(currentMonth);
    if (cached) {
      log.info(`Strategy cache hit for ${currentMonth}: best=${cached.best_strategy}`);
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
        'GET',
        `/employees/${employeeId}/work_records/${today}?company_id=${companyId}`
      );
      // If is_editable is true AND no company-level block, direct write should work
      // We can't truly test PUT without writing, but is_editable + no restriction is a good signal
      directOk = record.is_editable !== false;
      log.info(`Strategy probe: direct edit is_editable=${record.is_editable}`);
    } catch (err) {
      log.info(`Strategy probe: direct read failed: ${err.message.substring(0, 100)}`);
    }

    // Test 2: Do approval routes exist and are they API-compatible?
    try {
      const { primaryRouteId, fallbackRouteId } = await findAttendanceRouteIds(client, companyId);
      if (primaryRouteId || fallbackRouteId) {
        // We can't truly test without submitting, but if routes exist, approval is possible
        // The batch endpoint will detect dept/position blocks at runtime
        approvalOk = true;
        log.info(`Strategy probe: approval routes found (primary=${primaryRouteId}, fallback=${fallbackRouteId})`);
      }
    } catch (err) {
      log.info(`Strategy probe: approval route check failed: ${err.message.substring(0, 100)}`);
    }

    // Test 3: Time clocks — check if the endpoint is accessible
    try {
      // GET time_clocks to see if the API is available (doesn't write anything)
      await client.apiRequest(
        'GET',
        `/employees/${employeeId}/time_clocks?company_id=${companyId}&limit=1`
      );
      timeClockOk = true;
      log.info('Strategy probe: time_clocks API accessible');
    } catch (err) {
      log.info(`Strategy probe: time_clocks API not accessible: ${err.message.substring(0, 100)}`);
    }

    // Determine best strategy
    let bestStrategy = 'web'; // fallback
    if (directOk) bestStrategy = 'direct';
    else if (approvalOk) bestStrategy = 'approval';
    else if (timeClockOk) bestStrategy = 'time_clock';

    // Cache the result
    setStrategyCache(currentMonth, {
      direct_ok: directOk,
      approval_ok: approvalOk,
      time_clock_ok: timeClockOk,
      best_strategy: bestStrategy,
    });

    log.info(`Strategy detection complete for ${currentMonth}: best=${bestStrategy} (direct=${directOk}, approval=${approvalOk}, time_clock=${timeClockOk})`);

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
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/attendance/strategy-cache - Get current strategy cache status
 */
router.get('/strategy-cache', (req, res) => {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cached = getStrategyCache(currentMonth);
  res.json({
    month: currentMonth,
    cached: !!cached,
    ...(cached ? {
      direct_ok: !!cached.direct_ok,
      approval_ok: !!cached.approval_ok,
      time_clock_ok: !!cached.time_clock_ok,
      best_strategy: cached.best_strategy,
      detected_at: cached.detected_at,
    } : {}),
    web_credentials_configured: hasWebCredentials(),
  });
});

// ===================================================================
//  Leave Requests — via Web automation (Playwright)
// ===================================================================

/**
 * POST /api/attendance/leave-request - Submit a leave request via freee Web
 * Body: { type, date, reason? }
 * type: 'PaidHoliday' | 'SpecialHoliday' | 'Absence' | 'HolidayWork'
 */
router.post('/leave-request', async (req, res) => {
  const { type, date, reason } = req.body;

  if (!type || !date) {
    return res.status(400).json({ error: 'type and date are required' });
  }

  const validTypes = ['PaidHoliday', 'SpecialHoliday', 'Absence', 'HolidayWork'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid leave type. Valid: ${validTypes.join(', ')}` });
  }

  if (!hasWebCredentials()) {
    return res.status(400).json({ error: 'freee Web credentials not configured. Go to Settings to save your freee login.' });
  }

  try {
    log.info(`Submitting leave request: type=${type}, date=${date}`);
    const result = await submitLeaveRequest(type, date, { reason });

    if (result.success) {
      log.info(`Leave request submitted: ${type} for ${date}`);
      res.json({ success: true, type, date });
    } else {
      log.error(`Leave request failed: ${result.error}`);
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    log.error(`Leave request error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Keep legacy batch-work-time endpoint for backward compatibility
router.post('/approval/batch-work-time', async (req, res) => {
  const { entries, reason } = req.body;
  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries array is required and must not be empty' });
  }

  const oauth = requireOAuth(res);
  if (!oauth) return;
  const { companyId } = oauth;

  try {
    const client = new FreeeApiClient();
    await client.ensureValidToken();

    const routeId = await findAttendanceRouteId(client, companyId);

    log.info(`Legacy batch-work-time: ${entries.length} entries (route=${routeId})`);

    const results = [];
    for (const entry of entries) {
      try {
        const body = {
          company_id: parseInt(companyId, 10),
          target_date: entry.date,
        };
        if (routeId) body.approval_flow_route_id = routeId;
        // Approval API: work_records + break_records with time-only "HH:MM"
        if (entry.clock_in_at || entry.clock_out_at) {
          const workRecord = {};
          if (entry.clock_in_at) workRecord.clock_in_at = toTimeOnly(entry.clock_in_at);
          if (entry.clock_out_at) workRecord.clock_out_at = toTimeOnly(entry.clock_out_at);
          body.work_records = [workRecord];
        }
        if (entry.break_records && entry.break_records.length > 0) {
          body.break_records = entry.break_records.map(br => ({
            clock_in_at: toTimeOnly(br.clock_in_at),
            clock_out_at: toTimeOnly(br.clock_out_at),
          }));
        }
        if (reason) body.comment = reason;

        const result = await client.apiRequest(
          'POST',
          '/approval_requests/work_times',
          body
        );
        results.push({ date: entry.date, success: true, id: result.id || null });
      } catch (err) {
        results.push({ date: entry.date, success: false, error: err.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    res.json({ success: failed === 0, results, succeeded, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
