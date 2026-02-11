import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import api from '../api';

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
  is_holiday: boolean;
  is_absence: boolean;
  is_editable: boolean;
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

export interface BatchPunchResult {
  date: string;
  success: boolean;
  error?: string;
  method?: string;
}

export interface StrategyInfo {
  direct_disabled: boolean;
  approval_route_blocked: boolean;
  web_fallback_used: boolean;
  web_credentials_configured: boolean;
}

export interface ApprovalRequest {
  id: number;
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
  direct_edit: boolean;    // Can PUT work records directly
  approval: boolean;       // Has AttendanceWorkflow approval routes
  approval_route_id: number | null;
  role: string;            // self_only, company_admin, etc.
  company_name: string | null;
  display_name: string | null;
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
  approvalRequests: Record<string, ApprovalRequest>;
  approvalRequestsLoading: boolean;
  // Batch operations
  selectedDates: string[];
  batchPunchLoading: boolean;
  batchPunchResults: BatchPunchResult[];
  batchStrategyInfo: StrategyInfo | null;
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
  selectedDates: [],
  batchPunchLoading: false,
  batchPunchResults: [],
  batchStrategyInfo: null,
};

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
  async (id: number, { dispatch, getState }) => {
    await api.withdrawApprovalRequest(id);
    // Refresh approval requests
    const state = getState() as { attendance: AttendanceState };
    dispatch(fetchApprovalRequests({ year: state.attendance.year, month: state.attendance.month }));
    return id;
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
 * Frontend just sends dates + times + is_editable flag.
 * Server uses is_editable to decide PUT (direct) vs POST (approval).
 */
export const batchSubmit = createAsyncThunk(
  'attendance/batchSubmit',
  async (
    { entries, reason }: {
      entries: { date: string; clock_in_at: string; clock_out_at: string; is_editable?: boolean; break_records?: { clock_in_at: string; clock_out_at: string }[] }[];
      reason?: string;
    },
    { dispatch, getState }
  ) => {
    const res = await api.submitBatch({ entries, reason });
    const data = res.data as { results: BatchPunchResult[]; succeeded: number; failed: number; strategy_info?: StrategyInfo };
    // Refresh data after batch
    const state = getState() as { attendance: AttendanceState };
    dispatch(fetchAttendance({ year: state.attendance.year, month: state.attendance.month }));
    return { results: data.results, strategyInfo: data.strategy_info || null };
  }
);

// Legacy thunks kept for backward compat with BatchPunchModal
export const batchPunchDates = createAsyncThunk(
  'attendance/batchPunchDates',
  async (
    entries: { date: string; clock_in_at: string; clock_out_at: string; break_records?: { clock_in_at: string; clock_out_at: string }[] }[],
    { dispatch, getState }
  ) => {
    const results: BatchPunchResult[] = [];
    for (const entry of entries) {
      try {
        await api.putWorkRecord(entry.date, {
          clock_in_at: entry.clock_in_at,
          clock_out_at: entry.clock_out_at,
          break_records: entry.break_records,
        });
        results.push({ date: entry.date, success: true });
      } catch (err: any) {
        results.push({
          date: entry.date,
          success: false,
          error: err?.response?.data?.error || err.message,
        });
      }
      // Rate limiting: 200ms between requests
      await new Promise((r) => setTimeout(r, 200));
    }
    // Refresh data after batch
    const state = getState() as { attendance: AttendanceState };
    dispatch(fetchAttendance({ year: state.attendance.year, month: state.attendance.month }));
    return results;
  }
);

export const batchWorkTimeCorrection = createAsyncThunk(
  'attendance/batchWorkTimeCorrection',
  async (
    { entries, reason }: {
      entries: { date: string; clock_in_at: string; clock_out_at: string; break_records?: { clock_in_at: string; clock_out_at: string }[] }[];
      reason?: string;
    },
    { dispatch, getState }
  ) => {
    const res = await api.submitBatchWorkTimeCorrection({ entries, reason });
    const data = res.data as { results: BatchPunchResult[]; succeeded: number; failed: number };
    // Refresh data after batch
    const state = getState() as { attendance: AttendanceState };
    dispatch(fetchAttendance({ year: state.attendance.year, month: state.attendance.month }));
    return data.results;
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
    selectAllMissingDates(state) {
      const today = new Date().toISOString().slice(0, 10);
      const missing: string[] = [];
      for (const [date, record] of Object.entries(state.records)) {
        // Skip dates that have pending/approved approval requests
        const hasApproval = state.approvalRequests[date] &&
          (state.approvalRequests[date].status === 'in_progress' || state.approvalRequests[date].status === 'approved');
        if (
          date <= today && // Include today (CalendarView handles check-in time gate)
          record.day_pattern === 'normal_day' &&
          !record.clock_in &&
          !record.is_absence &&
          !record.is_holiday &&
          !hasApproval
        ) {
          missing.push(date);
        }
      }
      state.selectedDates = missing;
    },
    clearBatchResults(state) {
      state.batchPunchResults = [];
    },
  },
  extraReducers: (builder) => {
    // fetchApprovalRequests
    builder.addCase(fetchApprovalRequests.pending, (state) => {
      state.approvalRequestsLoading = true;
    });
    builder.addCase(fetchApprovalRequests.fulfilled, (state, action) => {
      const map: Record<string, ApprovalRequest> = {};
      for (const req of action.payload) {
        map[req.target_date] = req;
      }
      state.approvalRequests = map;
      state.approvalRequestsLoading = false;
    });
    builder.addCase(fetchApprovalRequests.rejected, (state) => {
      state.approvalRequestsLoading = false;
    });

    // withdrawApprovalRequest
    builder.addCase(withdrawApprovalRequest.fulfilled, (state, action) => {
      // Remove the withdrawn request from local state
      const id = action.payload;
      for (const [date, req] of Object.entries(state.approvalRequests)) {
        if (req.id === id) {
          delete state.approvalRequests[date];
          break;
        }
      }
    });

    // fetchCapabilities
    builder.addCase(fetchCapabilities.pending, (state) => {
      state.capabilitiesLoading = true;
    });
    builder.addCase(fetchCapabilities.fulfilled, (state, action) => {
      state.capabilities = action.payload;
      state.capabilitiesLoading = false;
    });
    builder.addCase(fetchCapabilities.rejected, (state) => {
      state.capabilitiesLoading = false;
    });

    // fetchAttendance
    builder.addCase(fetchAttendance.pending, (state) => {
      state.loading = true;
      state.error = null;
    });
    builder.addCase(fetchAttendance.fulfilled, (state, action) => {
      const map: Record<string, AttendanceRecord> = {};
      for (const rec of action.payload.records || []) {
        map[rec.date] = rec;
      }
      state.records = map;
      state.summary = action.payload.summary || null;
      state.year = action.payload.year;
      state.month = action.payload.month;
      state.loading = false;
    });
    builder.addCase(fetchAttendance.rejected, (state, action) => {
      state.loading = false;
      state.error = action.error.message || 'Failed to fetch attendance';
    });

    // batchSubmit (unified)
    builder.addCase(batchSubmit.pending, (state) => {
      state.batchPunchLoading = true;
      state.batchPunchResults = [];
      state.batchStrategyInfo = null;
    });
    builder.addCase(batchSubmit.fulfilled, (state, action) => {
      state.batchPunchLoading = false;
      state.batchPunchResults = action.payload.results;
      state.batchStrategyInfo = action.payload.strategyInfo;
      state.selectedDates = [];
    });
    builder.addCase(batchSubmit.rejected, (state) => {
      state.batchPunchLoading = false;
    });

    // batchPunchDates (legacy)
    builder.addCase(batchPunchDates.pending, (state) => {
      state.batchPunchLoading = true;
      state.batchPunchResults = [];
    });
    builder.addCase(batchPunchDates.fulfilled, (state, action) => {
      state.batchPunchLoading = false;
      state.batchPunchResults = action.payload;
      state.selectedDates = [];
    });
    builder.addCase(batchPunchDates.rejected, (state) => {
      state.batchPunchLoading = false;
    });

    // batchWorkTimeCorrection (legacy)
    builder.addCase(batchWorkTimeCorrection.pending, (state) => {
      state.batchPunchLoading = true;
      state.batchPunchResults = [];
    });
    builder.addCase(batchWorkTimeCorrection.fulfilled, (state, action) => {
      state.batchPunchLoading = false;
      state.batchPunchResults = action.payload;
      state.selectedDates = [];
    });
    builder.addCase(batchWorkTimeCorrection.rejected, (state) => {
      state.batchPunchLoading = false;
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
