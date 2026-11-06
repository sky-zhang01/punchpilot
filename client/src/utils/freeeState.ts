/**
 * Shared freee attendance state constants.
 * Used by ManualTrigger and DashboardPage to ensure consistent styling.
 */

export const STATE_COLORS: Record<string, string> = {
  not_checked_in: '#faad14',
  working: '#52c41a',
  on_break: '#1677ff',
  checked_out: '#8c8c8c',
  holiday: '#722ed1',
  disabled: '#d9d9d9',
  unknown: '#ff4d4f',
};

export const BADGE_STATUS: Record<
  string,
  'warning' | 'success' | 'processing' | 'default' | 'error'
> = {
  not_checked_in: 'warning',
  working: 'success',
  on_break: 'processing',
  checked_out: 'default',
  unknown: 'error',
};

export const STATE_LABEL_KEYS: Record<string, string> = {
  not_checked_in: 'manualTrigger.stateNotCheckedIn',
  working: 'manualTrigger.stateWorking',
  on_break: 'manualTrigger.stateOnBreak',
  checked_out: 'manualTrigger.stateCheckedOut',
  holiday: 'header.holiday',
  disabled: 'analysis.disabled',
  unknown: 'manualTrigger.stateUnknown',
};

export const HINT_KEYS: Record<string, string> = {
  not_checked_in: 'manualTrigger.hintNotCheckedIn',
  working: 'manualTrigger.hintWorking',
  on_break: 'manualTrigger.hintOnBreak',
  checked_out: 'manualTrigger.hintCheckedOut',
};
