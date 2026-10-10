import api, { invalidateIdentity, type QueryParams, type ApiResponse } from './http';
import { asyncBatchRequest, clearTaskReferences, getTask, resumeTask, type TaskDTO } from './tasks';

import type { StatusDTO, ScheduleUpdate } from './contracts';

type ApiCall<T = any> = Promise<ApiResponse<T>>;

async function identityRequest<T>(request: () => Promise<T>): Promise<T> {
  invalidateIdentity();
  try { return await request(); }
  finally { invalidateIdentity(); } // A lost response may still mean the server changed identity.
}

export interface ApprovalMutationContext {
  current_round: number;
  current_step_id: number;
  request_version: string;
}

export interface ApprovalActionRequest {
  id: number;
  type: string;
  action: 'approve' | 'feedback';
  expected: ApprovalMutationContext;
}

const apiClient = {
  // Auth
  login: (username: string, password: string): ApiCall => identityRequest(() => api.post('/auth/login', { username, password })),
  logout: (): ApiCall => { clearTaskReferences(); return identityRequest(() => api.post('/auth/logout')); },
  authStatus: (): ApiCall => api.get('/auth/status'),
  changePassword: (data: { old_password?: string; new_username?: string; new_password: string }): ApiCall =>
    api.put('/auth/password', data),

  // Status (dashboard)
  getStatus: (): ApiCall<StatusDTO> => api.get<StatusDTO>('/status'),
  getFreeeState: (): ApiCall => api.get('/status/freee-state'),

  // Config
  getConfig: (): ApiCall => api.get('/config'),
  updateConfig: (actionType: string, data: ScheduleUpdate): ApiCall => api.put(`/config/${actionType}`, data),
  toggleMaster: (): ApiCall => api.put('/config/toggle'),

  // Debug mode
  toggleDebug: (): ApiCall => identityRequest(() => api.put('/config/debug')),
  setDebug: (enabled: boolean): ApiCall => identityRequest(() => api.put('/config/debug/set', { enabled })),

  // Account (Browser mode)
  getAccount: (): ApiCall => api.get('/config/account'),
  saveAccount: (username: string, password: string, companyName: string): ApiCall =>
    identityRequest(() => api.put('/config/account', { username, password, company_name: companyName })),
  clearAccount: (): ApiCall => identityRequest(() => api.delete('/config/account')),
  verifyCredentials: (): ApiCall => api.post('/config/verify-credentials', {}, { timeout: 60000 }),
  verifyWebCredentials: (): ApiCall => identityRequest(() => api.post('/config/verify-web-credentials', {}, { timeout: 60000 })),

  // Connection Mode & OAuth (API mode)
  getConnectionMode: (): ApiCall => api.get('/config/connection-mode'),
  setConnectionMode: (mode: string): ApiCall => identityRequest(() => api.put('/config/connection-mode', { mode })),
  saveOAuthApp: (client_id: string, client_secret: string): ApiCall =>
    identityRequest(() => api.put('/config/oauth-app', { client_id, client_secret })),
  getOAuthAuthorizeUrl: (): ApiCall => api.post('/config/oauth-authorize-url'),
  getOAuthStatus: (): ApiCall => api.get('/config/oauth-status'),
  selectOAuthCompany: (company_id: string | number): ApiCall =>
    identityRequest(() => api.put('/config/oauth-select-company', { company_id })),
  verifyOAuthOnly: (): ApiCall => api.post('/config/verify-oauth'),
  verifyOAuth: (): ApiCall => identityRequest(() => api.post('/config/oauth-verify')),
  clearOAuth: (): ApiCall => identityRequest(() => api.delete('/config/oauth')),

  // Schedule
  getSchedule: (): ApiCall => api.get('/schedule'),
  triggerAction: (actionType: string): ApiCall => api.post(`/schedule/trigger/${actionType}`),

  // Logs
  getLogs: (params?: QueryParams): ApiCall => api.get('/logs', { params }),
  getTodayLogs: (): ApiCall => api.get('/logs/today'),
  getCalendarData: (year: number, month: number): ApiCall =>
    api.get('/logs/calendar', { params: { year, month } }),
  getLogDetail: (id: number | string): ApiCall => api.get(`/logs/${id}`),

  // Attendance records (freee sync)
  getAttendanceRecords: (year: number, month: number): ApiCall =>
    api.get('/attendance/records', { params: { year, month } }),
  getCapabilities: (): ApiCall =>
    api.get('/attendance/capabilities'),
  getEmployeeInfo: (): ApiCall =>
    api.get('/attendance/employee-info'),
  submitMonthlyAttendance: (data: { year: number; month: number }): ApiCall =>
    api.post('/attendance/approval/monthly', data),
  submitBatch: (data: { entries: any[]; reason?: string }): ApiCall<TaskDTO> =>
    asyncBatchRequest('/attendance/batch', data, 'batch_punch'),
  getTask,
  resumeTask,
  // Approval request tracking
  getApprovalRequests: (year: number, month: number): ApiCall =>
    api.get('/attendance/approval-requests', { params: { year, month } }),
  withdrawApprovalRequest: (id: number, type: string): ApiCall =>
    api.delete(`/attendance/approval-requests/${id}`, { params: { type } }),
  // Strategy detection
  detectStrategy: (force?: boolean): ApiCall =>
    api.post('/attendance/detect-strategy', { force }),
  getStrategyCache: (): ApiCall =>
    api.get('/attendance/strategy-cache'),
  // Leave requests
  getSpecialHolidayOptions: (date: string): ApiCall =>
    api.get('/attendance/special-holiday-options', { params: { date } }),
  submitLeaveRequest: (data: { type: string; date: string; reason?: string; holiday_type?: string; start_time?: string; end_time?: string; special_holiday_setting_id?: number }): ApiCall =>
    api.post('/attendance/leave-request', data, { timeout: 570_000 }),
  // Batch operations
  submitBatchLeaveRequest: (data: { type: string; dates: string[]; reason?: string; holiday_type?: string; start_time?: string; end_time?: string; special_holiday_setting_id?: number }): ApiCall<TaskDTO> =>
    asyncBatchRequest('/attendance/batch-leave-request', data, 'batch_leave'),
  batchWithdrawRequests: (data: { requests: Array<{ id: number; type: string }> }): ApiCall<TaskDTO> =>
    asyncBatchRequest('/attendance/batch-withdraw', data, 'batch_withdraw'),
  batchApproveRequests: (data: { requests: ApprovalActionRequest[] }): ApiCall<TaskDTO> =>
    asyncBatchRequest('/attendance/batch-approve', data, 'batch_approve'),
  getIncomingRequests: (year: number, month: number): ApiCall =>
    api.get('/attendance/incoming-requests', { params: { year, month } }),

  // Holiday skip countries (for auto-punch)
  setHolidaySkipCountries: (countries: string): ApiCall =>
    api.put('/config/holiday-skip-countries', { countries }),

  // Holidays
  getHolidayAvailableYears: (country?: string): ApiCall =>
    api.get('/holidays/available-years', { params: country ? { country } : undefined }),
  getHolidays: (params?: QueryParams): ApiCall => api.get('/holidays', { params }),
  getCnWorkdays: (year: number): ApiCall => api.get('/holidays/cn-workdays', { params: { year } }),
  getNationalHolidays: (): ApiCall => api.get('/holidays/national'),
  addCustomHoliday: (data: { date: string; description: string }): ApiCall => api.post('/holidays/custom', data),
  deleteCustomHoliday: (id: number | string): ApiCall => api.delete(`/holidays/custom/${id}`),
};

export default apiClient;
