import { describe, expect, it, vi } from 'vitest';
import {
  approveApprovalOperation,
  isCurrentApprover,
  withdrawApprovalOperation,
} from '../server/routes/attendance/approval-operation-service.js';
import { createApprovalMutationContext } from '../server/routes/attendance/approval-list-service.js';

const companyId = '12345';
const currentUserId = 8642;

function detail(overrides = {}) {
  return {
    id: 9753,
    company_id: 12345,
    applicant_id: currentUserId,
    status: 'in_progress',
    current_round: 1,
    current_step_id: 2468,
    approver_ids: [currentUserId],
    ...overrides,
  };
}

function codedError(code) {
  const error = new Error('synthetic upstream failure');
  error.code = code;
  return error;
}

function expected(overrides = {}) {
  const request = detail(overrides);
  return createApprovalMutationContext({
    request,
    companyId,
    currentUserId,
    type: 'PaidHoliday',
  });
}

function actionResponse(action, overrides = {}) {
  const status = action === 'cancel'
    ? 'draft'
    : action === 'feedback'
      ? 'feedback'
      : 'approved';
  return {
    paid_holiday: detail({
      status,
      approval_flow_logs: [{ user_id: currentUserId, action }],
      ...overrides,
    }),
  };
}

describe('approval operation ownership', () => {
  it('matches current-schema approver_ids and legacy current-step structures', () => {
    expect(isCurrentApprover(detail(), currentUserId)).toBe(true);
    expect(
      isCurrentApprover(
        detail({
          approver_ids: [],
          approval_steps: [
            { id: 2468, approvers: [{ user_id: currentUserId }] },
          ],
        }),
        currentUserId,
      ),
    ).toBe(true);
    expect(isCurrentApprover(detail({ approver_ids: [] }), currentUserId)).toBe(false);
  });
});

describe('withdraw approval operation', () => {
  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited object property names before any withdrawal call: %s',
    async (type) => {
      const apiRequest = vi.fn();
      const withdrawWeb = vi.fn();
      const result = await withdrawApprovalOperation({
        client: { apiRequest },
        companyId,
        currentUserId,
        id: 9753,
        type,
        webCredentialsAvailable: true,
        withdrawWeb,
      });

      expect(result).toMatchObject({
        success: false,
        error: 'invalid_withdraw_request',
      });
      expect(apiRequest).not.toHaveBeenCalled();
      expect(withdrawWeb).not.toHaveBeenCalled();
    },
  );

  it('includes company and confirmed step fields in cancel action', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce(actionResponse('cancel'));
    const withdrawWeb = vi.fn();

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb,
    });

    expect(result).toMatchObject({ success: true, method: 'cancel' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/approval_requests/paid_holidays/9753/actions?company_id=12345',
      {
        company_id: 12345,
        approval_action: 'cancel',
        target_round: 1,
        target_step_id: 2468,
      },
    );
    expect(withdrawWeb).not.toHaveBeenCalled();
  });

  it('treats an empty cancel response and unchanged re-read as unconfirmed', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ paid_holiday: detail() });

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb: vi.fn(),
    });

    expect(result).toMatchObject({
      success: false,
      method: 'cancel',
      error: 'mutation_outcome_unconfirmed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it('confirms an empty cancel response from one authoritative re-read', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(actionResponse('cancel'));

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb: vi.fn(),
    });

    expect(result).toMatchObject({ success: true, method: 'cancel' });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it.each(['API_TRANSIENT', 'API_RESPONSE_UNCONFIRMED']) (
    'stops after ambiguous cancel failure %s',
    async (code) => {
      const apiRequest = vi.fn()
        .mockResolvedValueOnce({ paid_holiday: detail() })
        .mockRejectedValueOnce(codedError(code));
      const withdrawWeb = vi.fn();

      const result = await withdrawApprovalOperation({
        client: { apiRequest },
        companyId,
        currentUserId,
        id: 9753,
        type: 'PaidHoliday',
        webCredentialsAvailable: true,
        withdrawWeb,
      });

      expect(result).toMatchObject({
        success: false,
        method: 'cancel',
        error: 'mutation_outcome_unconfirmed',
      });
      expect(apiRequest).toHaveBeenCalledTimes(2);
      expect(withdrawWeb).not.toHaveBeenCalled();
    },
  );

  it('does not switch to DELETE after a deterministic cancel rejection', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockRejectedValueOnce(codedError('API_ERROR_400'));
    const withdrawWeb = vi.fn().mockResolvedValue({ success: true });

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb,
    });

    expect(result).toMatchObject({ success: true, method: 'web_withdraw' });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(withdrawWeb).toHaveBeenCalledOnce();
  });

  it('stops after an ambiguous DELETE instead of using Web', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail({ status: 'draft' }) })
      .mockRejectedValueOnce(codedError('API_TRANSIENT'));
    const withdrawWeb = vi.fn();

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb,
    });

    expect(result).toMatchObject({
      success: false,
      method: 'delete',
      error: 'mutation_outcome_unconfirmed',
    });
    expect(withdrawWeb).not.toHaveBeenCalled();
  });

  it('uses DELETE only for a verified owned draft or feedback request', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail({ status: 'feedback' }) })
      .mockResolvedValueOnce(null);

    const result = await withdrawApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: false,
      withdrawWeb: vi.fn(),
    });

    expect(result).toMatchObject({ success: true, method: 'delete' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'DELETE',
      '/approval_requests/paid_holidays/9753?company_id=12345',
      null,
      { expectedStatus: 204 },
    );
  });

  it('does not mutate when detail or applicant ownership cannot be confirmed', async () => {
    const detailFailureApi = vi.fn().mockRejectedValueOnce(codedError('API_TRANSIENT'));
    const otherApplicantApi = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ applicant_id: 7531 }),
    });

    const detailFailure = await withdrawApprovalOperation({
      client: { apiRequest: detailFailureApi },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb: vi.fn(),
    });
    const otherApplicant = await withdrawApprovalOperation({
      client: { apiRequest: otherApplicantApi },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      webCredentialsAvailable: true,
      withdrawWeb: vi.fn(),
    });

    expect(detailFailure.error).toBe('approval_detail_unconfirmed');
    expect(otherApplicant.error).toBe('approval_ownership_unconfirmed');
    expect(detailFailureApi).toHaveBeenCalledTimes(1);
    expect(otherApplicantApi).toHaveBeenCalledTimes(1);
  });
});

describe('approve approval operation', () => {
  it('rejects inherited object property names before any approval call', async () => {
    const apiRequest = vi.fn();
    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'constructor',
      action: 'approve',
    });

    expect(result).toMatchObject({
      success: false,
      error: 'invalid_approval_request',
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('verifies ownership and sends the complete current action body', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce(actionResponse('approve'));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: true,
      method: 'approval_action',
      action: 'approve',
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/approval_requests/paid_holidays/9753/actions?company_id=12345',
      {
        company_id: 12345,
        approval_action: 'approve',
        target_round: 1,
        target_step_id: 2468,
      },
    );
  });

  it('treats an empty approval response and unchanged re-read as unconfirmed', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ paid_holiday: detail() });

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: false,
      method: 'approval_action',
      error: 'mutation_outcome_unconfirmed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it('confirms an empty approval response from one authoritative re-read', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(actionResponse('approve'));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: true,
      method: 'approval_action',
      action: 'approve',
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it('accepts the documented self-feedback draft with a new cancel log', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockResolvedValueOnce(actionResponse('feedback', {
        status: 'draft',
        approval_flow_logs: [{ user_id: currentUserId, action: 'cancel' }],
      }));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'feedback',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: true,
      method: 'approval_action',
      action: 'feedback',
    });
  });

  it('accepts an unspecified route only after an independent scoped-list confirmation', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail({ approver_ids: [] }) })
      .mockResolvedValueOnce({ paid_holiday: detail({ approver_ids: [] }) })
      .mockResolvedValueOnce(actionResponse('approve'));
    const confirmUnspecifiedApprover = vi.fn().mockResolvedValue(true);

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected({ approver_ids: [] }),
      confirmUnspecifiedApprover,
    });

    expect(result).toMatchObject({ success: true, method: 'approval_action' });
    expect(confirmUnspecifiedApprover).toHaveBeenCalledWith({
      id: 9753,
      type: 'PaidHoliday',
      detail: expect.objectContaining({ approver_ids: [] }),
    });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it('fails as detail-unconfirmed when the post-confirmation detail refresh fails', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail({ approver_ids: [] }) })
      .mockRejectedValueOnce(codedError('API_TRANSIENT'));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected({ approver_ids: [] }),
      confirmUnspecifiedApprover: vi.fn().mockResolvedValue(true),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'approval_detail_unconfirmed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('does not mutate when ownership or the current step cannot be confirmed', async () => {
    const noOwnerApi = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ approver_ids: [] }),
    });
    const noStepApi = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ current_step_id: null }),
    });

    const noOwner = await approveApprovalOperation({
      client: { apiRequest: noOwnerApi },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected({ approver_ids: [] }),
    });
    const noStep = await approveApprovalOperation({
      client: { apiRequest: noStepApi },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'feedback',
      expected: expected(),
    });

    expect(noOwner.error).toBe('approval_ownership_unconfirmed');
    expect(noStep.error).toBe('approval_step_unconfirmed');
    expect(noOwnerApi).toHaveBeenCalledTimes(1);
    expect(noStepApi).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous action response and never retries', async () => {
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockRejectedValueOnce(codedError('API_RESPONSE_UNCONFIRMED'));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'mutation_outcome_unconfirmed',
    });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing context', () => undefined],
    ['missing expected step', () => {
      const { current_step_id: _step, ...value } = expected();
      return value;
    }],
    ['string expected step', () => ({
      ...expected(),
      current_step_id: '2468',
    })],
  ])('fails closed before lookup for %s', async (_label, makeExpected) => {
    const apiRequest = vi.fn();
    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: makeExpected(),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'invalid_approval_request',
    });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('blocks a retry after an uncertain approve advanced to another eligible step', async () => {
    const observed = expected();
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockRejectedValueOnce(codedError('API_RESPONSE_UNCONFIRMED'))
      .mockResolvedValueOnce({
        paid_holiday: detail({ current_step_id: 3579 }),
      });
    const operation = {
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: observed,
    };

    const first = await approveApprovalOperation(operation);
    const retry = await approveApprovalOperation(operation);

    expect(first).toMatchObject({
      success: false,
      error: 'mutation_outcome_unconfirmed',
    });
    expect(retry).toMatchObject({
      success: false,
      error: 'approval_version_conflict',
    });
    expect(apiRequest.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('accepts the official initial round value zero when the observed detail matches', async () => {
    const current = detail({ current_round: 0 });
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: current })
      .mockResolvedValueOnce(actionResponse('approve', { current_round: 0 }));

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected({ current_round: 0 }),
    });

    expect(result).toMatchObject({ success: true, method: 'approval_action' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/approval_requests/paid_holidays/9753/actions?company_id=12345',
      expect.objectContaining({ target_round: 0, target_step_id: 2468 }),
    );
  });

  it('blocks stale approval content even when round and step are unchanged', async () => {
    const apiRequest = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ comment: 'changed after the UI read' }),
    });

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected({ comment: 'content shown by the UI' }),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'approval_version_conflict',
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('blocks a stale UI action after the approval round changes', async () => {
    const apiRequest = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ current_round: 2 }),
    });

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: expected(),
    });

    expect(result).toMatchObject({
      success: false,
      error: 'approval_version_conflict',
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects an approval context issued for another actor', async () => {
    const apiRequest = vi.fn().mockResolvedValueOnce({
      paid_holiday: detail({ approver_ids: [currentUserId, 8643] }),
    });
    const otherActorContext = createApprovalMutationContext({
      request: detail(),
      companyId,
      currentUserId: 8643,
      type: 'PaidHoliday',
    });

    const result = await approveApprovalOperation({
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'approve',
      expected: otherActorContext,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'approval_version_conflict',
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('blocks a feedback retry after the first outcome became feedback', async () => {
    const observed = expected();
    const apiRequest = vi.fn()
      .mockResolvedValueOnce({ paid_holiday: detail() })
      .mockRejectedValueOnce(codedError('API_TRANSIENT'))
      .mockResolvedValueOnce({
        paid_holiday: detail({ status: 'feedback' }),
      });
    const operation = {
      client: { apiRequest },
      companyId,
      currentUserId,
      id: 9753,
      type: 'PaidHoliday',
      action: 'feedback',
      expected: observed,
    };

    const first = await approveApprovalOperation(operation);
    const retry = await approveApprovalOperation(operation);

    expect(first.error).toBe('mutation_outcome_unconfirmed');
    expect(retry.error).toBe('approval_version_conflict');
    expect(apiRequest.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });
});
