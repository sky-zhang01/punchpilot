/** Shapes emitted by the status/config endpoints, shared by API, store and views. */
export interface ScheduleConfig {
  action_type: string;
  mode: 'fixed' | 'random';
  fixed_time: string | null;
  window_start: string | null;
  window_end: string | null;
  enabled: number;
  resolved_time?: string;
}
export type ScheduleUpdate = Partial<{
  [Key in 'mode' | 'fixed_time' | 'window_start' | 'window_end']: NonNullable<ScheduleConfig[Key]>;
}> & { enabled?: boolean };

export interface LogEntry {
  id: number;
  action_type: string;
  scheduled_time: string | null;
  executed_at: string;
  business_date: string | null;
  status: string;
  trigger_type: string;
  duration_ms: number | null;
  company_id: string | null;
  company_name: string | null;
  error_message: string | null;
  error_code: string | null;
  failure_stage: string | null;
  screenshot_before: string | null;
  screenshot_after: string | null;
}
export interface PunchTime { type: string; time: string; datetime: string }
export interface DailyScheduleStatus {
  date: string;
  action_type: string;
  resolved_time: string;
  executed: number;
  last_status: string;
  attempts: number;
  last_error: string | null;
}
export interface StatusDTO {
  auto_checkin_enabled: boolean;
  debug_mode: boolean;
  freee_configured: boolean;
  credentials_ok: boolean;
  connection_mode: string;
  attendance_state: string;
  current_date: string;
  timezone: string;
  is_holiday: boolean;
  calendar_guard_verified: boolean;
  today_schedule: Record<string, string>;
  today_schedule_status: DailyScheduleStatus[];
  today_logs: LogEntry[];
  today_punch_times: PunchTime[];
  next_action: (Pick<ScheduleConfig, 'action_type'> & Partial<Pick<ScheduleConfig, 'mode' | 'window_start' | 'window_end'>> & { time: string }) | null;
  startup_analysis: {
    state: string;
    reason: string;
    retrying?: boolean;
    retryAttempt?: number;
    retryMax?: number;
  } | null;
  skipped_actions: string[];
  auth_status: { broken: boolean; since: string; reason: string; last_error: string };
  configs: ScheduleConfig[];
}
