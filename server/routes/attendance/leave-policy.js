import { isDateString, isTimeString } from "../../../shared/date-time.js";
import { parseExternalId } from "../../freee-values.js";

export const LEAVE_TYPES = Object.freeze([
  "PaidHoliday",
  "SpecialHoliday",
  "Absence",
  "HolidayWork",
  "OvertimeWork",
]);

export const LEAVE_APPROVAL_ENDPOINTS = Object.freeze({
  PaidHoliday: "paid_holidays",
  SpecialHoliday: "special_holidays",
  OvertimeWork: "overtime_works",
});

const PAID_HOLIDAY_ALIASES = Object.freeze({
  full: "full",
  half: "half",
  morning: "morning_off",
  morning_off: "morning_off",
  afternoon: "afternoon_off",
  afternoon_off: "afternoon_off",
  hour: "hour",
  hourly: "hour",
});

const SPECIAL_HOLIDAY_ALIASES = Object.freeze({
  full: "full",
  half: "half",
  morning: "morning_off",
  morning_off: "morning_off",
  afternoon: "afternoon_off",
  afternoon_off: "afternoon_off",
  hour: "hour",
  hourly: "hour",
});

const PAID_APPROVAL_TYPES = Object.freeze({
  full: "full",
  half: "half",
  morning_off: "morning",
  afternoon_off: "afternoon",
  hour: "hourly",
});

const SPECIAL_APPROVAL_TYPES = Object.freeze({
  full: "full",
  half: "half",
  morning_off: "morning",
  afternoon_off: "afternoon",
  hour: "hour",
});

export class LeaveValidationError extends Error {
  constructor(message, code = "INVALID_LEAVE_REQUEST") {
    super(message);
    this.name = "LeaveValidationError";
    this.code = code;
  }
}

export const isValidDateString = isDateString;

function normalizePositiveInteger(value, field, { required = false } = {}) {
  if (value == null || value === "") {
    if (required) {
      throw new LeaveValidationError(`${field} is required`, "LEAVE_SETTING_REQUIRED");
    }
    return null;
  }
  const number = parseExternalId(value);
  if (number === null) {
    throw new LeaveValidationError(`${field} must be a positive integer`);
  }
  return number;
}

function normalizeReason(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new LeaveValidationError("reason must be a string");
  }
  const reason = value.trim();
  if (reason.length > 255) {
    throw new LeaveValidationError("reason must be 255 characters or less");
  }
  return reason || null;
}

function normalizeHolidayType(type, value) {
  if (type === "PaidHoliday") {
    const holidayType = (typeof (value ?? "full") === "string" && Object.hasOwn(PAID_HOLIDAY_ALIASES, value || "full") ? PAID_HOLIDAY_ALIASES[value || "full"] : null);
    if (!holidayType) {
      throw new LeaveValidationError("holiday_type is not valid for paid leave");
    }
    return holidayType;
  }
  if (type === "SpecialHoliday") {
    const holidayType = (typeof (value ?? "full") === "string" && Object.hasOwn(SPECIAL_HOLIDAY_ALIASES, value || "full") ? SPECIAL_HOLIDAY_ALIASES[value || "full"] : null);
    if (!holidayType) {
      throw new LeaveValidationError("holiday_type is not valid for special leave");
    }
    return holidayType;
  }
  if (value != null && value !== "") {
    throw new LeaveValidationError("holiday_type is only valid for leave requests");
  }
  return null;
}

function normalizeTimes(type, holidayType, startTime, endTime) {
  const hasStart = startTime != null && startTime !== "";
  const hasEnd = endTime != null && endTime !== "";
  if (hasStart !== hasEnd) {
    throw new LeaveValidationError("start_time and end_time must be provided together");
  }
  if (hasStart && (!isTimeString(startTime) || !isTimeString(endTime))) {
    throw new LeaveValidationError("start_time and end_time must use HH:MM format");
  }

  const needsTimes =
    type === "OvertimeWork" ||
    ((type === "PaidHoliday" || type === "SpecialHoliday") &&
      ["half", "hour"].includes(holidayType));
  if (needsTimes && !hasStart) {
    throw new LeaveValidationError(
      "start_time and end_time are required for this request",
    );
  }
  if (
    hasStart &&
    type !== "OvertimeWork" &&
    type !== "HolidayWork" &&
    !["half", "hour"].includes(holidayType)
  ) {
    throw new LeaveValidationError("times are not valid for this leave type");
  }
  if (hasStart && type !== "OvertimeWork" && startTime >= endTime) {
    throw new LeaveValidationError("end_time must be later than start_time");
  }
  return { startTime: hasStart ? startTime : null, endTime: hasEnd ? endTime : null };
}

export function normalizeLeaveRequest(input, dateOverride = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LeaveValidationError("request body must be an object");
  }
  const type = input.type;
  const date = dateOverride || input.date;
  if (!LEAVE_TYPES.includes(type)) {
    throw new LeaveValidationError("type is not a supported leave request type");
  }
  if (!isValidDateString(date)) {
    throw new LeaveValidationError("date must be a valid YYYY-MM-DD date");
  }

  const holidayType = normalizeHolidayType(type, input.holiday_type);
  const { startTime, endTime } = normalizeTimes(
    type,
    holidayType,
    input.start_time,
    input.end_time,
  );

  if (
    type !== "SpecialHoliday" &&
    input.special_holiday_setting_id != null &&
    input.special_holiday_setting_id !== ""
  ) {
    throw new LeaveValidationError(
      "special_holiday_setting_id is only valid for special leave",
    );
  }

  return {
    type,
    date,
    reason: normalizeReason(input.reason),
    holidayType,
    startTime,
    endTime,
    specialHolidaySettingId:
      type === "SpecialHoliday"
        ? normalizePositiveInteger(
            input.special_holiday_setting_id,
            "special_holiday_setting_id",
          )
        : null,
  };
}

export function normalizeBatchLeaveRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LeaveValidationError("request body must be an object");
  }
  if (!Array.isArray(input.dates) || input.dates.length === 0) {
    throw new LeaveValidationError("dates must be a non-empty array");
  }
  if (input.dates.length > 50) {
    throw new LeaveValidationError("Maximum 50 dates per batch request");
  }
  if (new Set(input.dates).size !== input.dates.length) {
    throw new LeaveValidationError("dates must be unique");
  }
  return input.dates.map((date) => normalizeLeaveRequest(input, date));
}

function selectedRoute(routeInfo) {
  if (!routeInfo?.lookupVerified) return null;
  if (routeInfo.primaryRouteId) {
    const id = parseExternalId(routeInfo.primaryRouteId);
    if (!id) {
      throw new LeaveValidationError(
        "The approval route could not be confirmed",
        "APPROVAL_ROUTE_UNCONFIRMED",
      );
    }
    const approverId = parseExternalId(routeInfo.primaryRouteUserId);
    if (routeInfo.primaryRouteUserId && !approverId) {
      throw new LeaveValidationError(
        "The approval route approver could not be confirmed",
        "APPROVER_SELECTION_REQUIRED",
      );
    }
    return {
      id,
      approverId,
      needsApprover: routeInfo.primaryRouteNeedsApprover === true,
    };
  }
  if (routeInfo.fallbackRouteId) {
    const id = parseExternalId(routeInfo.fallbackRouteId);
    if (!id) {
      throw new LeaveValidationError(
        "The approval route could not be confirmed",
        "APPROVAL_ROUTE_UNCONFIRMED",
      );
    }
    return { id, approverId: null, needsApprover: false };
  }
  return null;
}

export function buildLeaveApprovalBody(request, companyId, routeInfo) {
  const route = selectedRoute(routeInfo);
  if (!route) return null;
  if (route.needsApprover && !route.approverId) {
    throw new LeaveValidationError(
      "An approver must be selected in freee Web",
      "APPROVER_SELECTION_REQUIRED",
    );
  }

  const body = {
    company_id: Number(companyId),
    target_date: request.date,
    approval_flow_route_id: route.id,
  };
  if (request.reason) body.comment = request.reason;
  if (route.approverId) body.approver_id = Number(route.approverId);

  if (request.type === "PaidHoliday") {
    const value = { type: PAID_APPROVAL_TYPES[request.holidayType] };
    if (["half", "hour"].includes(request.holidayType)) {
      value.start_at = request.startTime;
      value.end_at = request.endTime;
    }
    body.values = [value];
  } else if (request.type === "SpecialHoliday") {
    if (!request.specialHolidaySettingId) {
      throw new LeaveValidationError(
        "special_holiday_setting_id is required",
        "LEAVE_SETTING_REQUIRED",
      );
    }
    body.special_holiday_setting_id = request.specialHolidaySettingId;
    body.holiday_type = SPECIAL_APPROVAL_TYPES[request.holidayType];
    if (["half", "hour"].includes(request.holidayType)) {
      body.start_at = request.startTime;
      body.end_at = request.endTime;
    }
  } else if (request.type === "OvertimeWork") {
    body.start_at = request.startTime;
    body.end_at = request.endTime;
  }
  return body;
}

export function buildDirectLeaveBody(request, companyId) {
  const body = { company_id: Number(companyId) };
  if (request.type === "PaidHoliday" && request.holidayType === "full") {
    return { ...body, paid_holidays: [{ type: "full" }] };
  }
  if (request.type === "SpecialHoliday" && request.holidayType === "full") {
    if (!request.specialHolidaySettingId) return null;
    return {
      ...body,
      special_holiday: 1,
      special_holiday_setting_id: request.specialHolidaySettingId,
    };
  }
  if (request.type === "Absence") return { ...body, is_absence: true };
  return null;
}

export function canSubmitLeaveViaWeb(request) {
  if (request.type === "PaidHoliday") return request.holidayType === "full";
  if (request.type === "SpecialHoliday") return false;
  return ["Absence", "HolidayWork", "OvertimeWork"].includes(request.type);
}

export function leaveWebOptions(request) {
  return {
    reason: request.reason || undefined,
    startTime: request.startTime || undefined,
    endTime: request.endTime || undefined,
    holidayType: request.holidayType || undefined,
    specialHolidaySettingId: request.specialHolidaySettingId || undefined,
  };
}

export function extractLeaveApprovalId(request, response) {
  if (!response || typeof response !== "object") return null;
  const responseKeys = {
    PaidHoliday: "paid_holiday",
    SpecialHoliday: "special_holiday",
    OvertimeWork: "overtime_work",
  };
  const value = response.id ?? response[responseKeys[request.type]]?.id;
  return parseExternalId(value);
}
