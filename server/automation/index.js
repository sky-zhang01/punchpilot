/**
 * Barrel file — re-exports the public API from automation modules.
 * Maintains backward compatibility with `import { ... } from './automation.js'`.
 */

// Re-export FREEE_STATE for consumers
export { FREEE_STATE } from "../constants.js";

// Public API
export {
  detectCurrentState,
  executeAction,
  submitWebCorrections,
  scrapeEmployeeProfile,
  submitLeaveRequest,
  withdrawApprovalRequestWeb,
  submitMonthlyAttendanceClosingWeb,
} from "./public-api.js";

// Scheduling
export { determineActionsForToday } from "./scheduling.js";

// Utils (re-exported for backward compatibility)
export {
  getConnectionMode,
  hasCredentials,
  isDebugMode,
  hasWebCredentials,
} from "./utils.js";
