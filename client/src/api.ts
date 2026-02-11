import axios, { AxiosResponse } from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !err.config.url.includes('/auth/')) {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Generic response helper type
type ApiCall<T = any> = Promise<AxiosResponse<T>>;

const apiClient = {
  // Auth
  login: (username: string, password: string): ApiCall => api.post('/auth/login', { username, password }),
  logout: (): ApiCall => api.post('/auth/logout'),
  authStatus: (): ApiCall => api.get('/auth/status'),
  changePassword: (data: { current_password?: string; new_username?: string; new_password: string }): ApiCall =>
    api.put('/auth/password', data),

  // Status (dashboard)
  getStatus: (): ApiCall => api.get('/status'),
  getFreeeState: (): ApiCall => api.get('/status/freee-state'),

  // Config
  getConfig: (): ApiCall => api.get('/config'),
  updateConfig: (actionType: string, data: Record<string, any>): ApiCall => api.put(`/config/${actionType}`, data),
  toggleMaster: (): ApiCall => api.put('/config/toggle'),

  // Debug mode
  toggleDebug: (): ApiCall => api.put('/config/debug'),
  setDebug: (enabled: boolean): ApiCall => api.put('/config/debug/set', { enabled }),

  // Account (Browser mode)
  getAccount: (): ApiCall => api.get('/config/account'),
  saveAccount: (username: string, password: string): ApiCall => api.put('/config/account', { username, password }),
  clearAccount: (): ApiCall => api.delete('/config/account'),
  verifyCredentials: (): ApiCall => api.post('/config/verify-credentials', {}, { timeout: 60000 }),

  // Connection Mode & OAuth (API mode)
  getConnectionMode: (): ApiCall => api.get('/config/connection-mode'),
  setConnectionMode: (mode: string): ApiCall => api.put('/config/connection-mode', { mode }),
  saveOAuthApp: (client_id: string, client_secret: string): ApiCall =>
    api.put('/config/oauth-app', { client_id, client_secret }),
  getOAuthAuthorizeUrl: (): ApiCall => api.get('/config/oauth-authorize-url'),
  getOAuthStatus: (): ApiCall => api.get('/config/oauth-status'),
  selectOAuthCompany: (company_id: string | number): ApiCall =>
    api.put('/config/oauth-select-company', { company_id }),
  verifyOAuth: (): ApiCall => api.post('/config/oauth-verify'),
  clearOAuth: (): ApiCall => api.delete('/config/oauth'),

  // Schedule
  getSchedule: (): ApiCall => api.get('/schedule'),
  triggerAction: (actionType: string): ApiCall => api.post(`/schedule/trigger/${actionType}`),

  // Logs
  getLogs: (params?: Record<string, any>): ApiCall => api.get('/logs', { params }),
  getTodayLogs: (): ApiCall => api.get('/logs/today'),
  getCalendarData: (year: number, month: number): ApiCall =>
    api.get('/logs/calendar', { params: { year, month } }),
  getLogDetail: (id: number | string): ApiCall => api.get(`/logs/${id}`),

  // Attendance records (freee sync)
  getAttendanceRecords: (year: number, month: number): ApiCall =>
    api.get('/attendance/records', { params: { year, month } }),
  putWorkRecord: (date: string, data: Record<string, any>): ApiCall =>
    api.put(`/attendance/records/${date}`, data),
  getCapabilities: (): ApiCall =>
    api.get('/attendance/capabilities'),
  getApprovalRoutes: (): ApiCall =>
    api.get('/attendance/approval-routes'),
  getEmployeeInfo: (): ApiCall =>
    api.get('/attendance/employee-info'),
  submitMonthlyAttendance: (data: { year: number; month: number }): ApiCall =>
    api.post('/attendance/approval/monthly', data),
  submitWorkTimeCorrection: (data: Record<string, any>): ApiCall =>
    api.post('/attendance/approval/work-time', data),
  submitBatch: (data: { entries: any[]; reason?: string }): ApiCall =>
    api.post('/attendance/batch', data, { timeout: 5 * 60 * 1000 }),
  // Approval request tracking
  getApprovalRequests: (year: number, month: number): ApiCall =>
    api.get('/attendance/approval-requests', { params: { year, month } }),
  withdrawApprovalRequest: (id: number, type?: string): ApiCall =>
    api.delete(`/attendance/approval-requests/${id}`, { params: type ? { type } : undefined }),
  // Strategy detection
  detectStrategy: (force?: boolean): ApiCall =>
    api.post('/attendance/detect-strategy', { force }),
  getStrategyCache: (): ApiCall =>
    api.get('/attendance/strategy-cache'),
  // Leave requests (4-stage fallback: direct → approval API → Playwright)
  submitLeaveRequest: (data: { type: string; date: string; reason?: string; holiday_type?: string; start_time?: string; end_time?: string }): ApiCall =>
    api.post('/attendance/leave-request', data, { timeout: 3 * 60 * 1000 }),
  // Legacy — kept for backward compat
  submitBatchWorkTimeCorrection: (data: { entries: any[]; reason?: string }): ApiCall =>
    api.post('/attendance/approval/batch-work-time', data),

  // Holiday skip countries (for auto-punch)
  setHolidaySkipCountries: (countries: string): ApiCall =>
    api.put('/config/holiday-skip-countries', { countries }),

  // Holidays
  getHolidayAvailableYears: (country?: string): ApiCall =>
    api.get('/holidays/available-years', { params: country ? { country } : undefined }),
  getHolidays: (params?: Record<string, any>): ApiCall => api.get('/holidays', { params }),
  getNationalHolidays: (): ApiCall => api.get('/holidays/national'),
  addCustomHoliday: (data: { date: string; description: string }): ApiCall => api.post('/holidays/custom', data),
  deleteCustomHoliday: (id: number | string): ApiCall => api.delete(`/holidays/custom/${id}`),
};

export default apiClient;
