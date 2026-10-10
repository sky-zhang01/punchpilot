import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import api from '../api';
import { assertIdentity, getIdentityEpoch } from '../http';
import { taskFailure, type TaskDTO, type TaskFailure, type TaskItemResult, type StrategyInfo } from '../tasks';
export type { StrategyInfo } from '../tasks';
import { businessDate, businessMinutes } from '../utils/date-time';
import { isTimeString, timeToMinutes } from '../../../shared/date-time.js';
import type { ScheduleConfig, StatusDTO } from '../contracts';
import { ACTION_TYPES } from '../../../shared/schedule-policy.js';

// --- Types ---

export interface BreakRecord {
  clock_in: string | null;
  clock_out: string | null;
}

export interface AttendanceRecord {
  date: string;
  clock_in: string | null;
  clock_out: string | null;
  day_pattern: string;
  schedule_pattern: string;
  is_holiday: boolean;
  is_absence: boolean;
  is_editable: boolean;
  is_non_working_day: boolean;
  non_working_day_code: string | null;
  has_leave: boolean;
  total_work_mins: number;
  total_overtime_mins: number;
  lateness_mins: number;
  early_leaving_mins: number;
  paid_holiday: number;
  note: string;
  break_records: BreakRecord[];
}

export interface MonthlySummary {
  work_days: number;
  total_work_mins: number;
  total_normal_work_mins: number;
  total_overtime_work_mins: number;
  total_prescribed_holiday_work_mins: number;
  total_holiday_work_mins: number;
  total_latenight_work_mins: number;
  num_absences: number;
  num_paid_holidays: number;
  num_paid_holidays_left: number;
  num_paid_holidays_and_hours: { days: number; hours: number };
  num_paid_holidays_and_hours_left: { days: number; hours: number };
  total_lateness_and_early_leaving_mins: number;
}

export type BatchPunchResult = TaskItemResult;

export interface ApprovalRequest {
  id: number;
  type: string;
  status: string;           // 'in_progress' | 'approved' | 'feedback'
  target_date: string;
  work_records: { clock_in_at: string | null; clock_out_at: string | null }[];
  break_records: { clock_in_at: string | null; clock_out_at: string | null }[];
  comment: string;
  request_number: string | null;
  created_at: string | null;
}

/** What the current company/role supports */
export interface Capabilities {
  direct_edit: boolean;
  approval: boolean;
  approval_route_verified: boolean;
}

interface AttendanceState {
  records: Record<string, AttendanceRecord>;
  summary: MonthlySummary | null;
  year: number;
  month: number;
  loading: boolean;
  error: string | null;
  // Capabilities detection
  capabilities: Capabilities | null;
  capabilitiesLoading: boolean;
  // Approval requests
  approvalRequests: Record<string, ApprovalRequest[]>;
  approvalRequestsLoading: boolean;
  approvalRequestsRequestId: string | null;
  attendanceRequestId: string | null;
  // Batch operations
  selectedDates: string[];
  batchPunchLoading: boolean;
  batchPunchResults: BatchPunchResult[];
  batchStrategyInfo: StrategyInfo | null;
  batchTask: TaskDTO | null;
  batchError: TaskFailure | null;
  batchRequestId: string | null;
  capabilitiesRequestId: string | null;
  withdrawRequestId: string | null;
}

const now = new Date();
const initialState: AttendanceState = {
  records: {},
  summary: null,
  year: now.getFullYear(),
  month: now.getMonth() + 1,
  loading: false,
  error: null,
  capabilities: null,
  capabilitiesLoading: false,
  approvalRequests: {},
  approvalRequestsLoading: false,
  approvalRequestsRequestId: null,
  attendanceRequestId: null,
  selectedDates: [],
  batchPunchLoading: false,
  batchPunchResults: [],
  batchStrategyInfo: null,
  batchTask: null,
  batchError: null,
  batchRequestId: null,
  capabilitiesRequestId: null,
  withdrawRequestId: null,
};

export function isAttendanceNonWorking(record: AttendanceRecord | undefined): boolean {
  return !!record && (
    record.is_non_working_day ||
    record.is_absence ||
    record.is_holiday
  );
}

export interface MissingPunchContext { today: string; todayEligible: boolean }
export function missingPunchContext(
  schedules: Array<Pick<ScheduleConfig, 'action_type' | 'mode' | 'fixed_time' | 'window_end'>>,
  status: Pick<StatusDTO, 'timezone' | 'attendance_state'> & { today_logs?: Array<Pick<StatusDTO['today_logs'][number], 'action_type' | 'status'>> } | null,
  now = new Date(),
): MissingPunchContext {
  const checkin = schedules.find(schedule => schedule.action_type === 'checkin');
  const endTime = checkin?.mode === 'random' ? checkin.window_end : checkin?.fixed_time;
  const state = status?.attendance_state;
  const hasActivity = !!state && !['not_checked_in', 'unknown', 'holiday', 'disabled'].includes(state)
    || (status?.today_logs || []).some(log => ACTION_TYPES.includes(log.action_type || '') && log.status === 'success');
  return { today: businessDate(status?.timezone, now),
    todayEligible: !!status && isTimeString(endTime) && businessMinutes(status.timezone, now) >= timeToMinutes(endTime!) && !hasActivity };
}
export function isMissingPunch(date: string, record: AttendanceRecord | undefined, approvals: ApprovalRequest[], context: MissingPunchContext): boolean {
  return date <= context.today && (date !== context.today || context.todayEligible)
    && !!record && record.day_pattern === 'normal_day' && !record.clock_in && !isAttendanceNonWorking(record)
    && !approvals.some(request => request.status === 'in_progress' || request.status === 'approved');
}

// --- Thunks ---

export const fetchCapabilities = createAsyncThunk(
  'attendance/fetchCapabilities',
  async () => {
    const res = await api.getCapabilities();
    return res.data as Capabilities;
  }
);

export const fetchApprovalRequests = createAsyncThunk(
  'attendance/fetchApprovalRequests',
  async ({ year, month }: { year: number; month: number }) => {
    const res = await api.getApprovalRequests(year, month);
    return res.data.requests as ApprovalRequest[];
  }
);

export const withdrawApprovalRequest = createAsyncThunk(
  'attendance/withdrawApprovalRequest',
  async ({ id, type }: { id: number; type: string }, { dispatch, getState }) => {
    await api.withdrawApprovalRequest(id, type);
    // Refresh approval requests
    const state = getState() as { attendance: AttendanceState };
    dispatch(fetchApprovalRequests({ year: state.attendance.year, month: state.attendance.month }));
    return { id, type };
  }
);

export const fetchAttendance = createAsyncThunk(
  'attendance/fetchAttendance',
  async ({ year, month }: { year: number; month: number }) => {
    const res = await api.getAttendanceRecords(year, month);
    return res.data as {
      records: AttendanceRecord[];
      summary: MonthlySummary | null;
      year: number;
      month: number;
    };
  }
);

/**
 * Unified batch punch — server auto-decides per-date strategy.
 * Frontend sends requested dates and times. The server re-reads freee before
 * deciding whether direct editing, approval, or Web automation is safe.
 */
export const batchSubmit = createAsyncThunk(
  'attendance/batchSubmit',
  async (
    { entries, reason }: {
      entries: { date: string; clock_in_at: string; clock_out_at: string; is_editable?: boolean; break_records?: { clock_in_at: string; clock_out_at: string }[] }[];
      reason?: string;
    },
    { dispatch, getState, rejectWithValue }
  ) => {
    const epoch = getIdentityEpoch();
    try {
      const { data } = await api.submitBatch({ entries, reason });
      assertIdentity(epoch);
      const state = getState() as { attendance: AttendanceState };
      dispatch(fetchAttendance({ year: state.attendance.year, month: state.attendance.month }));
      return { results: data.results, strategyInfo: data.strategy_info, task: data };
    } catch (error) {
      assertIdentity(epoch);
      const failure = taskFailure(error);
      if (failure) return rejectWithValue(failure);
      throw error;
    }
  }
);

// --- Slice ---

const attendanceSlice = createSlice({
  name: 'attendance',
  initialState,
  reducers: {
    setYearMonth(state, action: PayloadAction<{ year: number; month: number }>) {
      state.year = action.payload.year;
      state.month = action.payload.month;
      state.loading = false;
      state.approvalRequestsLoading = false;
      state.attendanceRequestId = null;
      state.approvalRequestsRequestId = null;
    },
    toggleDateSelection(state, action: PayloadAction<string>) {
      const date = action.payload;
      const idx = state.selectedDates.indexOf(date);
      if (idx >= 0) {
        state.selectedDates.splice(idx, 1);
      } else {
        state.selectedDates.push(date);
      }
    },
    clearDateSelection(state) {
      state.selectedDates = [];
    },
    selectAllMissingDates(state, action: PayloadAction<MissingPunchContext | undefined>) {
      const context = action.payload || { today: businessDate(), todayEligible: false };
      state.selectedDates = Object.entries(state.records)
        .filter(([date, record]) => isMissingPunch(date, record, state.approvalRequests[date] || [], context))
        .map(([date]) => date);
    },
    clearBatchResults(state) {
      state.batchPunchResults = [];
    },
  },
  extraReducers: (builder) => {
    builder.addCase('account/identityChanged', (state) => ({ ...initialState, year: state.year, month: state.month }));
    // fetchApprovalRequests
    builder.addCase(fetchApprovalRequests.pending, (state, action) => {
      state.approvalRequestsLoading = true;
      state.approvalRequestsRequestId = action.meta.requestId;
    });
    builder.addCase(fetchApprovalRequests.fulfilled, (state, action) => {
      if (
        state.approvalRequestsRequestId !== action.meta.requestId ||
        state.year !== action.meta.arg.year ||
        state.month !== action.meta.arg.month
      ) return;
      const map: Record<string, ApprovalRequest[]> = {};
      for (const req of action.payload) {
        if (!map[req.target_date]) map[req.target_date] = [];
        map[req.target_date].push(req);
      }
      state.approvalRequests = map;
      state.approvalRequestsLoading = false;
      state.approvalRequestsRequestId = null;
    });
    builder.addCase(fetchApprovalRequests.rejected, (state, action) => {
      if (state.approvalRequestsRequestId !== action.meta.requestId) return;
      state.approvalRequestsLoading = false;
      state.approvalRequestsRequestId = null;
    });

    // withdrawApprovalRequest
    builder.addCase(withdrawApprovalRequest.pending, (state, action) => { state.withdrawRequestId = action.meta.requestId; });
    builder.addCase(withdrawApprovalRequest.fulfilled, (state, action) => {
      if (state.withdrawRequestId !== action.meta.requestId) return;
      state.withdrawRequestId = null;
      // Remove the withdrawn request from local state
      const { id, type } = action.payload;
      for (const [date, requests] of Object.entries(state.approvalRequests)) {
        const remaining = requests.filter((request) =>
          request.id !== id || request.type !== type);
        if (remaining.length === 0) delete state.approvalRequests[date];
        else state.approvalRequests[date] = remaining;
      }
    });

    // fetchCapabilities
    builder.addCase(fetchCapabilities.pending, (state, action) => {
      state.capabilitiesRequestId = action.meta.requestId;
      state.capabilitiesLoading = true;
    });
    builder.addCase(fetchCapabilities.fulfilled, (state, action) => {
      if (state.capabilitiesRequestId !== action.meta.requestId) return;
      state.capabilitiesRequestId = null;
      state.capabilities = action.payload;
      state.capabilitiesLoading = false;
    });
    builder.addCase(fetchCapabilities.rejected, (state, action) => {
      if (state.capabilitiesRequestId !== action.meta.requestId) return;
      state.capabilitiesRequestId = null;
      state.capabilitiesLoading = false;
    });

    // fetchAttendance
    builder.addCase(fetchAttendance.pending, (state, action) => {
      state.loading = true;
      state.error = null;
      state.attendanceRequestId = action.meta.requestId;
    });
    builder.addCase(fetchAttendance.fulfilled, (state, action) => {
      if (
        state.attendanceRequestId !== action.meta.requestId ||
        state.year !== action.meta.arg.year ||
        state.month !== action.meta.arg.month ||
        action.payload.year !== action.meta.arg.year ||
        action.payload.month !== action.meta.arg.month
      ) return;
      const map: Record<string, AttendanceRecord> = {};
      for (const rec of action.payload.records || []) {
        map[rec.date] = rec;
      }
      state.records = map;
      state.summary = action.payload.summary || null;
      state.year = action.payload.year;
      state.month = action.payload.month;
      state.loading = false;
      state.attendanceRequestId = null;
    });
    builder.addCase(fetchAttendance.rejected, (state, action) => {
      if (state.attendanceRequestId !== action.meta.requestId) return;
      state.loading = false;
      state.attendanceRequestId = null;
      state.error = action.error.message || 'Failed to fetch attendance';
    });

    // batchSubmit (unified)
    builder.addCase(batchSubmit.pending, (state, action) => {
      state.batchRequestId = action.meta.requestId;
      state.batchError = null;
      state.batchTask = null;
      state.batchPunchLoading = true;
      state.batchPunchResults = [];
      state.batchStrategyInfo = null;
    });
    builder.addCase(batchSubmit.fulfilled, (state, action) => {
      if (state.batchRequestId !== action.meta.requestId) return;
      state.batchRequestId = null;
      state.batchTask = action.payload.task;
      state.batchPunchLoading = false;
      state.batchPunchResults = action.payload.results;
      state.batchStrategyInfo = action.payload.strategyInfo;
      if (action.payload.task.success) state.selectedDates = [];
    });
    builder.addCase(batchSubmit.rejected, (state, action) => {
      if (state.batchRequestId !== action.meta.requestId) return;
      state.batchRequestId = null;
      state.batchPunchLoading = false;
      const failure = action.payload as TaskFailure | undefined;
      state.batchError = failure || null;
      if (failure?.task) {
        state.batchTask = failure.task;
        state.batchPunchResults = failure.task.results;
        state.batchStrategyInfo = failure.task.strategy_info;
      }
    });

  },
});

export const {
  setYearMonth,
  toggleDateSelection,
  clearDateSelection,
  selectAllMissingDates,
  clearBatchResults,
} = attendanceSlice.actions;

export default attendanceSlice.reducer;
