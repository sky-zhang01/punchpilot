/**
 * Shared constants to avoid circular imports between modules.
 */

// freee error messages returned in page body text
export const FREEE_ERROR_MESSAGES = {
  MONTHLY_CLOSING_ALREADY_SUBMITTED: "既に月次勤怠締め申請が行われています",
};

// freee attendance states
export const FREEE_STATE = {
  NOT_CHECKED_IN: "not_checked_in",
  WORKING: "working",
  ON_BREAK: "on_break",
  CHECKED_OUT: "checked_out",
  UNKNOWN: "unknown",
};
