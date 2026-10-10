import type { StatusDTO } from './contracts';

export function statusFixture(overrides: Partial<StatusDTO> = {}): StatusDTO {
  return {
    auto_checkin_enabled: true, debug_mode: true, freee_configured: false, credentials_ok: false,
    connection_mode: 'api', attendance_state: 'unknown', current_date: '2026-10-04', timezone: 'Asia/Tokyo',
    is_holiday: false, calendar_guard_verified: true, today_schedule: {}, today_schedule_status: [],
    today_logs: [], today_punch_times: [], next_action: null, startup_analysis: null, skipped_actions: [],
    auth_status: { broken: false, since: '', reason: '', last_error: '' }, configs: [], ...overrides,
  };
}
