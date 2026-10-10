import { describe, expect, it, vi } from 'vitest';
import {
  createApprovalMutationContext,
  approvalRequestInMonth,
  fetchApprovalRequestPages,
  parseApprovalMutationContext,
  parseApprovalMonth,
} from '../server/routes/attendance/approval-list-service.js';

describe('approval mutation context', () => {
  const request = {
    id: 9753,
    company_id: 12345,
    current_round: 1,
    current_step_id: 2468,
    comment: 'original request content',
    values: [{ type: 'full' }],
  };

  it('binds the observed round and step to the request and actor', () => {
    const context = createApprovalMutationContext({
      request,
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    });

    expect(context).toMatchObject({
      current_round: 1,
      current_step_id: 2468,
      request_version: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/),
    });
    expect(createApprovalMutationContext({
      request,
      companyId: 12345,
      currentUserId: 8643,
      type: 'PaidHoliday',
    })?.request_version).not.toBe(context.request_version);
    expect(createApprovalMutationContext({
      request: { ...request, id: 9754 },
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    })?.request_version).not.toBe(context.request_version);
    expect(createApprovalMutationContext({
      request: { ...request, comment: 'changed request content' },
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    })?.request_version).not.toBe(context.request_version);
    const reordered = {
      values: request.values,
      current_step_id: request.current_step_id,
      comment: request.comment,
      company_id: request.company_id,
      id: request.id,
      current_round: request.current_round,
    };
    expect(createApprovalMutationContext({
      request: reordered,
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    })?.request_version).toBe(context.request_version);
    expect(createApprovalMutationContext({
      request: { ...request, comment: 'x'.repeat(256 * 1024) },
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    })).toBeNull();
  });

  it('strictly parses client-returned contexts and rejects malformed steps', () => {
    const context = createApprovalMutationContext({
      request,
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    });

    expect(parseApprovalMutationContext(context)).toEqual(context);
    expect(parseApprovalMutationContext({
      ...context,
      current_step_id: '2468',
    })).toBeNull();
    expect(parseApprovalMutationContext({
      ...context,
      current_step_id: 0,
    })).toBeNull();
    expect(parseApprovalMutationContext({
      current_round: 1,
      request_version: context.request_version,
    })).toBeNull();
    const roundZero = createApprovalMutationContext({
      request: { ...request, current_round: 0 },
      companyId: 12345,
      currentUserId: 8642,
      type: 'PaidHoliday',
    });
    expect(roundZero?.current_round).toBe(0);
    expect(parseApprovalMutationContext(roundZero)).toEqual(roundZero);
    expect(parseApprovalMutationContext({
      ...context,
      current_round: -1,
    })).toBeNull();
  });
});

describe('approval month validation', () => {
  it('builds exact leap-year boundaries and rejects malformed values', () => {
    expect(parseApprovalMonth('2028', '2')).toEqual({
      year: 2028,
      month: 2,
      prefix: '2028-02',
      startDate: '2028-02-01',
      endDate: '2028-02-29',
    });
    expect(parseApprovalMonth('2026x', '5')).toBeNull();
    expect(parseApprovalMonth('2026', '13')).toBeNull();
  });

  it('matches daily and monthly-closing targets without loose parsing', () => {
    const range = parseApprovalMonth('2026', '5');
    expect(approvalRequestInMonth({ target_date: '2026-05-18' }, range)).toBe(true);
    expect(approvalRequestInMonth({ target_date: '2026-06-01' }, range)).toBe(false);
    expect(
      approvalRequestInMonth({ target_year: 2026, target_month: 5 }, range),
    ).toBe(true);
  });
});

describe('approval list pagination', () => {
  it('binds applicant and month filters to every request', async () => {
    const apiRequest = vi.fn().mockResolvedValue({ paid_holidays: [] });
    const range = parseApprovalMonth('2026', '5');

    await fetchApprovalRequestPages({
      client: { apiRequest },
      companyId: 12345,
      type: 'PaidHoliday',
      status: 'approved',
      range,
      applicantId: 8642,
    });

    const [, path] = apiRequest.mock.calls[0];
    const query = new URL(`https://example.invalid${path}`).searchParams;
    expect(query.get('company_id')).toBe('12345');
    expect(query.get('applicant_id')).toBe('8642');
    expect(query.get('start_target_date')).toBe('2026-05-01');
    expect(query.get('end_target_date')).toBe('2026-05-31');
    expect(query.get('limit')).toBe('100');
  });

  it('uses approver scope for incoming requests', async () => {
    const apiRequest = vi.fn().mockResolvedValue({ work_times: [] });

    await fetchApprovalRequestPages({
      client: { apiRequest },
      companyId: 12345,
      type: 'WorkTime',
      status: 'in_progress',
      range: parseApprovalMonth('2026', '5'),
      approverId: 8642,
    });

    const [, path] = apiRequest.mock.calls[0];
    expect(new URL(`https://example.invalid${path}`).searchParams.get('approver_id'))
      .toBe('8642');
  });

  it('rejects malformed successful responses instead of treating them as empty', async () => {
    await expect(
      fetchApprovalRequestPages({
        client: { apiRequest: vi.fn().mockResolvedValue({}) },
        companyId: 12345,
        type: 'PaidHoliday',
        status: 'approved',
        range: parseApprovalMonth('2026', '5'),
        applicantId: 8642,
      }),
    ).rejects.toMatchObject({ code: 'API_RESPONSE_UNCONFIRMED' });
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited object property names as approval types: %s',
    async (type) => {
      const apiRequest = vi.fn();
      await expect(
        fetchApprovalRequestPages({
          client: { apiRequest },
          companyId: 12345,
          type,
          status: 'approved',
          range: parseApprovalMonth('2026', '5'),
          applicantId: 8642,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_APPROVAL_LIST_QUERY' });
      expect(apiRequest).not.toHaveBeenCalled();
    },
  );
});
