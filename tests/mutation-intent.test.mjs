import { describe, expect, it, vi } from "vitest";

import {
  assertApprovalMutationRequest,
  assertApprovalWithdrawalMutationRequest,
  assertMonthlyClosingMutationRequest,
  assertTimeClockMutationRequest,
} from "../server/automation/mutation-intent.js";

function browserRequest({
  url = "https://p.secure.freee.co.jp/api/private/employee_portal/time_clocks",
  method = "POST",
  body,
  json = body,
} = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: vi.fn(() => method),
    url: vi.fn(() => url),
    postDataBuffer: vi.fn(() => Buffer.from(text || "", "utf8")),
    postData: vi.fn(() => text || ""),
    postDataJSON: vi.fn(() => {
      if (json instanceof Error) throw json;
      return json;
    }),
  };
}

describe("Web mutation intent binding", () => {
  it("binds an attendance request to its action, identity, and date", () => {
    const request = browserRequest({
      body: {
        time_clock: {
          type: "clock_in",
          employee_id: 1001,
          company_id: 101,
          base_date: "2026-07-13",
        },
      },
    });

    expect(() => assertTimeClockMutationRequest(request, {
      actionType: "checkin",
      employeeId: "1001",
      companyId: "101",
      date: "2026-07-13",
    })).not.toThrow();
  });

  it.each([
    [{ type: "clock_out", base_date: "2026-07-13" }, "checkin"],
    [{ type: "clock_in", employee_id: 2002 }, "checkin"],
    [{ type: "clock_in", employee_id: "invalid" }, "checkin"],
    [{ type: "clock_in", base_date: "2026-07-14" }, "checkin"],
    [{ type: ["clock_in", "clock_out"] }, "checkin"],
    [{ type: "clock_in", metadata: { type: "unrecognized" } }, "checkin"],
  ])("rejects a mismatched or ambiguous attendance body", (body, actionType) => {
    expect(() => assertTimeClockMutationRequest(browserRequest({ body }), {
      actionType,
      employeeId: "1001",
      date: "2026-07-13",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("accepts a bounded URL-encoded body", () => {
    const body = "time_clock%5Btype%5D=break_begin&time_clock%5Bbase_date%5D=2026-07-13";
    expect(() => assertTimeClockMutationRequest(browserRequest({
      body,
      json: new Error("not JSON"),
    }), {
      actionType: "break_start",
      date: "2026-07-13",
    })).not.toThrow();
  });

  it("rejects conflicting attendance targets carried only in the URL query", () => {
    const request = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/employee_portal/time_clocks" +
        "?employee_id=2002&company_id=999&base_date=2026-07-14",
      body: { type: "clock_in" },
    });
    expect(() => assertTimeClockMutationRequest(request, {
      actionType: "checkin",
      employeeId: "1001",
      companyId: "101",
      date: "2026-07-13",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("rejects a target selector that the operation identity cannot bind", () => {
    const request = browserRequest({
      body: { type: "clock_in", company_id: 101 },
    });
    expect(() => assertTimeClockMutationRequest(request, {
      actionType: "checkin",
      employeeId: "1001",
      date: "2026-07-13",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("rejects absent and oversized request bodies without exposing them", () => {
    for (const body of ["", `type=clock_in&padding=${"x".repeat(101 * 1024)}`]) {
      let caught;
      try {
        assertTimeClockMutationRequest(browserRequest({
          body,
          json: new Error("not JSON"),
        }), { actionType: "checkin" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" });
      expect(caught.message).not.toContain("padding");
    }
  });

  it("binds an approval request to the exact request type and target date", () => {
    const request = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/approval_requests/requests",
      body: {
        approval_request: {
          type: "ApprovalRequest::PaidHoliday",
          target_date: "2026-07-13",
          employee_id: 1001,
          company_id: 101,
        },
      },
    });
    expect(() => assertApprovalMutationRequest(request, {
      requestType: "ApprovalRequest::PaidHoliday",
      date: "2026-07-13",
      employeeId: "1001",
      companyId: "101",
    })).not.toThrow();
    expect(() => assertApprovalMutationRequest(request, {
      requestType: "ApprovalRequest::SpecialHoliday",
      date: "2026-07-13",
      employeeId: "1001",
      companyId: "101",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("rejects a conflicting approval identity in body or query", () => {
    const request = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/approval_requests/requests" +
        "?company_id=999",
      body: {
        approval_request: {
          type: "ApprovalRequest::PaidHoliday",
          target_date: "2026-07-13",
          employee_id: 2002,
        },
      },
    });
    expect(() => assertApprovalMutationRequest(request, {
      requestType: "ApprovalRequest::PaidHoliday",
      date: "2026-07-13",
      employeeId: "1001",
      companyId: "101",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("rejects an approval-looking segment outside the allowlisted path", () => {
    const request = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/other/approval_requests/requests",
      body: {
        type: "ApprovalRequest::PaidHoliday",
        target_date: "2026-07-13",
      },
    });
    expect(() => assertApprovalMutationRequest(request, {
      requestType: "ApprovalRequest::PaidHoliday",
      date: "2026-07-13",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("binds monthly closing to the exact year, month, and identity", () => {
    const request = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/approval_requests/requests",
      body: {
        approval_request: {
          type: "ApprovalRequest::MonthlyAttendance",
          target_year: 2026,
          target_month: 7,
          employee_id: 1001,
          company_id: 101,
        },
      },
    });
    expect(() => assertMonthlyClosingMutationRequest(request, {
      year: 2026,
      month: 7,
      employeeId: "1001",
      companyId: "101",
    })).not.toThrow();
    expect(() => assertMonthlyClosingMutationRequest(request, {
      year: 2026,
      month: 8,
      employeeId: "1001",
      companyId: "101",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
    const ambiguous = browserRequest({
      url: "https://p.secure.freee.co.jp/api/private/approval_requests/requests" +
        "?target_month=99",
      body: {
        type: "ApprovalRequest::MonthlyAttendance",
        target_year: 2026,
        target_month: 7,
      },
    });
    expect(() => assertMonthlyClosingMutationRequest(ambiguous, {
      year: 2026,
      month: 7,
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("binds approval withdrawal to one exact request id", () => {
    const request = browserRequest({
      method: "DELETE",
      url: "https://p.secure.freee.co.jp/api/private/employees/approval_requests/requests",
      body: {
        approval_request: {
          request_id: 12345,
          type: "ApprovalRequest::PaidHoliday",
          employee_id: 1001,
          company_id: 101,
        },
      },
    });
    expect(() => assertApprovalWithdrawalMutationRequest(request, {
      requestId: "12345",
      requestType: "ApprovalRequest::PaidHoliday",
      employeeId: "1001",
      companyId: "101",
    })).not.toThrow();
    for (const expected of ["54321", "invalid"]) {
      expect(() => assertApprovalWithdrawalMutationRequest(request, {
        requestId: expected,
        requestType: "ApprovalRequest::PaidHoliday",
        employeeId: "1001",
        companyId: "101",
      })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
    }
    expect(() => assertApprovalWithdrawalMutationRequest(browserRequest({
      method: "POST",
      url: "https://p.secure.freee.co.jp/api/private/employees/approval_requests/requests",
      body: { request_id: 12345 },
    }), {
      requestId: "12345",
      requestType: "ApprovalRequest::PaidHoliday",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("rejects ambiguous withdrawal ids across path and body", () => {
    const request = browserRequest({
      method: "DELETE",
      url: "https://p.secure.freee.co.jp/api/private/employees/approval_requests/requests/12345",
      body: { request_id: 54321, type: "withdraw" },
    });
    expect(() => assertApprovalWithdrawalMutationRequest(request, {
      requestId: "12345",
      requestType: "ApprovalRequest::PaidHoliday",
    })).toThrow(expect.objectContaining({ code: "WEB_MUTATION_REQUEST_UNTRUSTED" }));
  });

  it("accepts a bodyless withdrawal only when the trusted URL carries the id", () => {
    const request = browserRequest({
      method: "DELETE",
      url: "https://p.secure.freee.co.jp/api/private/employees/approval_requests/requests/12345",
    });
    expect(() => assertApprovalWithdrawalMutationRequest(request, {
      requestId: "12345",
      requestType: "ApprovalRequest::PaidHoliday",
    })).not.toThrow();
  });
});
