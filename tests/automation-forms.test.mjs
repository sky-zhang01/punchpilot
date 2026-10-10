import { describe, expect, it, vi } from 'vitest';

import { FREEE_ERROR_MESSAGES } from '../server/constants.js';
import {
  assertApprovalFormTarget,
  assertFormTargetDate,
  assertMonthlyClosingTarget,
  assertSubmissionConfirmed,
  assertWithdrawalTarget,
  submitLeaveRequest,
  submitMonthlyClosingWeb,
  submitWorkTimeCorrection,
  withdrawApprovalRequest,
} from '../server/automation/forms.js';

const MONTHLY_TYPE = 'ApprovalRequest::MonthlyAttendance';
const MONTHLY_FORM_URL = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=${MONTHLY_TYPE}&target_year=2026&target_month=7`;
const MONTHLY_SUCCESS_URL = 'https://p.secure.freee.co.jp/approval_requests#/requests';
const WITHDRAWAL_TYPE = 'ApprovalRequest::PaidHoliday';
const WITHDRAWAL_ID = '12345';
const WITHDRAWAL_URL = `https://p.secure.freee.co.jp/approval_requests#requests/${WITHDRAWAL_ID}?type=${encodeURIComponent(WITHDRAWAL_TYPE)}`;
const WORK_TIME_TYPE = 'ApprovalRequest::WorkTime';
const PAID_HOLIDAY_TYPE = 'ApprovalRequest::PaidHoliday';
const TARGET_DATE = '2026-07-10';

function formUrl(requestType, date = TARGET_DATE) {
  return `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=${encodeURIComponent(requestType)}&target_date=${date}`;
}

function mutationRequest(
  body,
  url = 'https://p.secure.freee.co.jp/api/private/approval_requests/requests',
  method = 'POST',
) {
  const text = JSON.stringify(body);
  return {
    method: vi.fn(() => method),
    url: vi.fn(() => url),
    postDataBuffer: vi.fn(() => Buffer.from(text)),
    postData: vi.fn(() => text),
    postDataJSON: vi.fn(() => body),
  };
}

describe('freee Web form target guard', () => {
  it.each([
    ['2026-07-10', '2026-07-10'],
    ['2026/7/10', '2026-07-10'],
    ['2026\u5e747\u670810\u65e5', '2026-07-10'],
  ])('accepts equivalent date formats', (actual, expected) => {
    expect(() => assertFormTargetDate(actual, expected)).not.toThrow();
  });

  it('fails closed when the rendered date does not match the request', () => {
    expect(() => assertFormTargetDate('2026-07-11', '2026-07-10')).toThrow(
      expect.objectContaining({ code: 'WEB_FORM_TARGET_MISMATCH' }),
    );
  });

  it('binds ordinary approval forms to route type, rendered type, and date', () => {
    expect(() => assertApprovalFormTarget({
      url: formUrl(WORK_TIME_TYPE),
      requestType: WORK_TIME_TYPE,
      date: TARGET_DATE,
    }, WORK_TIME_TYPE, TARGET_DATE)).not.toThrow();

    for (const observation of [
      {
        url: formUrl(PAID_HOLIDAY_TYPE),
        requestType: WORK_TIME_TYPE,
        date: TARGET_DATE,
      },
      {
        url: formUrl(WORK_TIME_TYPE),
        requestType: PAID_HOLIDAY_TYPE,
        date: TARGET_DATE,
      },
      {
        url: formUrl(WORK_TIME_TYPE),
        requestType: WORK_TIME_TYPE,
        date: '2026-07-11',
      },
    ]) {
      expect(() => assertApprovalFormTarget(
        observation,
        WORK_TIME_TYPE,
        TARGET_DATE,
      )).toThrow(expect.objectContaining({ code: 'WEB_FORM_TARGET_MISMATCH' }));
    }
  });

  it('requires the rendered monthly request type, year, and month', () => {
    expect(() => assertMonthlyClosingTarget({
      requestType: MONTHLY_TYPE,
      year: 2026,
      month: 7,
    }, 2026, 7)).not.toThrow();
    expect(() => assertMonthlyClosingTarget({
      requestType: MONTHLY_TYPE,
      year: '2026\u5e74',
      month: '7\u6708',
    }, 2026, 7)).not.toThrow();

    for (const observed of [
      { requestType: 'ApprovalRequest::WorkTime', year: 2026, month: 7 },
      { requestType: MONTHLY_TYPE, year: 2026, month: 8 },
      MONTHLY_FORM_URL,
    ]) {
      expect(() => assertMonthlyClosingTarget(observed, 2026, 7)).toThrow(
        expect.objectContaining({ code: 'WEB_FORM_TARGET_MISMATCH' }),
      );
    }
  });
});

function createApprovalFormGuardBot({
  routeType,
  renderedType,
  missingSelector = null,
} = {}) {
  let currentUrl = formUrl(routeType);
  const dateInput = {
    count: vi.fn(async () => 1),
    first: vi.fn(function first() { return this; }),
    inputValue: vi.fn(async () => TARGET_DATE),
  };
  const absent = { count: vi.fn(async () => 0) };
  const unexpectedClick = vi.fn();
  const page = {
    evaluate: vi.fn(async (_fn, payload) => {
      if (payload?.kind === 'approval-form-target') return renderedType;
      throw new Error('unexpected evaluation');
    }),
    keyboard: { press: vi.fn() },
    locator: vi.fn((selector) => {
      if (selector.includes('approval-request-date-input') ||
          selector === '#approval-request-fields-date') return dateInput;
      if (selector === missingSelector) return absent;
      return {
        click: unexpectedClick,
        count: vi.fn(async () => 0),
      };
    }),
    url: vi.fn(() => currentUrl),
    waitForTimeout: vi.fn(),
  };
  const bot = {
    navigateToSpaForm: vi.fn(async (url) => {
      currentUrl = formUrl(routeType) || url;
    }),
    page,
    waitForElement: vi.fn(async (predicate) => {
      expect(await predicate()).toBe(true);
    }),
  };
  return { bot, unexpectedClick };
}

describe('ordinary approval form mutation guard', () => {
  it('does not touch correction fields when the rendered request type differs', async () => {
    const { bot, unexpectedClick } = createApprovalFormGuardBot({
      routeType: WORK_TIME_TYPE,
      renderedType: PAID_HOLIDAY_TYPE,
    });

    await expect(submitWorkTimeCorrection(bot, TARGET_DATE, {
      clockInHour: 9,
      clockInMin: 0,
      clockOutHour: 18,
      clockOutMin: 0,
    })).rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(unexpectedClick).not.toHaveBeenCalled();
  });

  it('does not touch leave fields when the route points to another type', async () => {
    const { bot, unexpectedClick } = createApprovalFormGuardBot({
      routeType: WORK_TIME_TYPE,
      renderedType: PAID_HOLIDAY_TYPE,
    });

    await expect(submitLeaveRequest(bot, 'PaidHoliday', TARGET_DATE))
      .rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(unexpectedClick).not.toHaveBeenCalled();
  });

  it('fails closed when a requested leave field is absent', async () => {
    const startSelector = '#approval-request-fields-started-at';
    const { bot, unexpectedClick } = createApprovalFormGuardBot({
      routeType: PAID_HOLIDAY_TYPE,
      renderedType: PAID_HOLIDAY_TYPE,
      missingSelector: startSelector,
    });

    await expect(submitLeaveRequest(bot, 'PaidHoliday', TARGET_DATE, {
      startTime: '10:00',
    })).rejects.toMatchObject({ code: 'WEB_FORM_FIELDS_UNCONFIRMED' });
    expect(unexpectedClick).not.toHaveBeenCalled();
  });
});

function createCorrectionSubmissionBot({ mutationDate = TARGET_DATE } = {}) {
  let currentUrl = formUrl(WORK_TIME_TYPE);
  const input = (initial = '') => {
    let value = initial;
    return {
      click: vi.fn(async () => {}),
      count: vi.fn(async () => 1),
      fill: vi.fn(async (next) => { value = String(next); }),
      inputValue: vi.fn(async () => value),
    };
  };
  const dateInput = { ...input(TARGET_DATE), first: vi.fn(function first() { return this; }) };
  const modifyRadio = {
    ...input(),
    isChecked: vi.fn(async () => true),
  };
  const submitButton = {
    click: vi.fn(async () => {
      currentUrl = 'https://p.secure.freee.co.jp/approval_requests#/requests';
    }),
    count: vi.fn(async () => 1),
  };
  const absent = { count: vi.fn(async () => 0) };
  const fields = new Map();
  const page = {
    evaluate: vi.fn(async (_fn, payload) => {
      if (payload?.kind === 'approval-form-target') return WORK_TIME_TYPE;
      return {
        successIndicator: true,
        errorIndicator: false,
        acceptedIndicator: false,
      };
    }),
    keyboard: { press: vi.fn(async () => {}) },
    locator: vi.fn((selector) => {
      if (selector.includes('approval-request-date-input')) return dateInput;
      if (selector === '[data-testid="clear-work-time-false"]') return modifyRadio;
      if (selector === '#approval-request-fields-break-clock-in-at-hour-0') return absent;
      if (selector === '#approval-request-fields-approver_id') return absent;
      if (selector === 'button[type="submit"]') {
        return { filter: vi.fn(() => submitButton) };
      }
      if (selector.startsWith('#approval-request-fields-segment-')) {
        if (!fields.has(selector)) fields.set(selector, input());
        return fields.get(selector);
      }
      return absent;
    }),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
  };
  const bot = {
    assertPreMutationGuard: vi.fn(async () => {}),
    checkSubmitResult: vi.fn(async () => ({ success: true })),
    dispatchGuardedMutation: vi.fn(async (locator, { validateRequest }) => {
      validateRequest(mutationRequest({
        approval_request: {
          type: WORK_TIME_TYPE,
          target_date: mutationDate,
        },
      }));
      await bot.assertPreMutationGuard();
      await locator.click();
    }),
    navigateToSpaForm: vi.fn(async (url) => { currentUrl = url; }),
    page,
    takeScreenshots: vi.fn(() => ({
      before: vi.fn(async () => null),
      after: vi.fn(async () => null),
    })),
    waitForElement: vi.fn(async (predicate) => {
      expect(await predicate()).toBe(true);
    }),
  };
  return { bot, submitButton };
}

describe('work-time correction dispatch guard', () => {
  const times = {
    clockInHour: 9,
    clockInMin: 0,
    clockOutHour: 18,
    clockOutMin: 0,
  };

  it('submits only after validating the intercepted request', async () => {
    const { bot, submitButton } = createCorrectionSubmissionBot();
    await expect(submitWorkTimeCorrection(bot, TARGET_DATE, times))
      .resolves.toMatchObject({ success: true });
    expect(bot.dispatchGuardedMutation).toHaveBeenCalledOnce();
    expect(submitButton.click).toHaveBeenCalledOnce();
  });

  it('does not submit an intercepted correction for another date', async () => {
    const { bot, submitButton } = createCorrectionSubmissionBot({
      mutationDate: '2026-07-11',
    });
    await expect(submitWorkTimeCorrection(bot, TARGET_DATE, times))
      .rejects.toMatchObject({ code: 'WEB_MUTATION_REQUEST_UNTRUSTED' });
    expect(submitButton.click).not.toHaveBeenCalled();
  });
});

function createLeaveSubmissionBot({
  mutationBody = {
    approval_request: {
      type: PAID_HOLIDAY_TYPE,
      target_date: TARGET_DATE,
    },
  },
} = {}) {
  let currentUrl = formUrl(PAID_HOLIDAY_TYPE);
  const dateInput = {
    count: vi.fn(async () => 1),
    inputValue: vi.fn(async () => TARGET_DATE),
  };
  const submitButton = {
    click: vi.fn(async () => {
      currentUrl = 'https://p.secure.freee.co.jp/approval_requests#/requests';
    }),
    count: vi.fn(async () => 1),
  };
  const page = {
    evaluate: vi.fn(async (_fn, payload) => {
      if (payload?.kind === 'approval-form-target') return PAID_HOLIDAY_TYPE;
      return {
        successIndicator: true,
        errorIndicator: false,
        acceptedIndicator: false,
      };
    }),
    locator: vi.fn((selector) => {
      if (selector === '#approval-request-fields-date') return dateInput;
      if (selector === 'button[type="submit"]') {
        return { filter: vi.fn(() => submitButton) };
      }
      return { count: vi.fn(async () => 0) };
    }),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn(async () => {}),
  };
  const bot = {
    assertPreMutationGuard: vi.fn(async () => {}),
    checkSubmitResult: vi.fn(async () => ({ success: true })),
    navigateToSpaForm: vi.fn(async (url) => {
      currentUrl = url;
    }),
    page,
    takeScreenshots: vi.fn(() => ({
      before: vi.fn(async () => null),
      after: vi.fn(async () => null),
    })),
    dispatchGuardedMutation: vi.fn(async (locator, {
      validateRequest,
      beforeDispatch,
    }) => {
      const request = {
        method: vi.fn(() => 'POST'),
        url: vi.fn(() =>
          'https://p.secure.freee.co.jp/api/private/approval_requests/requests'),
        postDataBuffer: vi.fn(() => Buffer.from(JSON.stringify(mutationBody))),
        postData: vi.fn(() => JSON.stringify(mutationBody)),
        postDataJSON: vi.fn(() => mutationBody),
      };
      validateRequest(request);
      await bot.assertPreMutationGuard();
      await beforeDispatch(request);
      await locator.click();
    }),
    waitForElement: vi.fn(async (predicate) => {
      expect(await predicate()).toBe(true);
    }),
  };
  return { bot, submitButton };
}

describe('leave form final record guard', () => {
  it('rechecks the target record while the exact submit request is paused', async () => {
    const { bot, submitButton } = createLeaveSubmissionBot();
    const preSubmitGuard = vi.fn().mockResolvedValue({ skip: false });

    await expect(submitLeaveRequest(
      bot,
      'PaidHoliday',
      TARGET_DATE,
      {},
      preSubmitGuard,
    )).resolves.toMatchObject({ success: true });
    expect(preSubmitGuard).toHaveBeenCalledOnce();
    expect(bot.assertPreMutationGuard).toHaveBeenCalledOnce();
    expect(bot.dispatchGuardedMutation).toHaveBeenCalledOnce();
    expect(submitButton.click).toHaveBeenCalledOnce();
  });

  it('does not click when the final record guard observes an existing leave', async () => {
    const { bot, submitButton } = createLeaveSubmissionBot();
    const preSubmitGuard = vi.fn().mockResolvedValue({
      skip: true,
      reason: 'already_non_working_day',
    });

    await expect(submitLeaveRequest(
      bot,
      'PaidHoliday',
      TARGET_DATE,
      {},
      preSubmitGuard,
    )).resolves.toMatchObject({
      success: true,
      skipped: true,
      reason: 'already_non_working_day',
    });
    expect(bot.assertPreMutationGuard).toHaveBeenCalledOnce();
    expect(submitButton.click).not.toHaveBeenCalled();
  });

  it('does not click when no final record guard is provided', async () => {
    const { bot, submitButton } = createLeaveSubmissionBot();

    await expect(submitLeaveRequest(
      bot,
      'PaidHoliday',
      TARGET_DATE,
    )).rejects.toMatchObject({ code: 'WEB_WORK_RECORD_UNCONFIRMED' });
    expect(submitButton.click).not.toHaveBeenCalled();
  });

  it('does not submit when the intercepted payload targets another date', async () => {
    const { bot, submitButton } = createLeaveSubmissionBot({
      mutationBody: {
        approval_request: {
          type: PAID_HOLIDAY_TYPE,
          target_date: '2026-07-11',
        },
      },
    });
    const preSubmitGuard = vi.fn().mockResolvedValue({ skip: false });

    await expect(submitLeaveRequest(
      bot,
      'PaidHoliday',
      TARGET_DATE,
      {},
      preSubmitGuard,
    )).rejects.toMatchObject({ code: 'WEB_MUTATION_REQUEST_UNTRUSTED' });
    expect(preSubmitGuard).not.toHaveBeenCalled();
    expect(submitButton.click).not.toHaveBeenCalled();
  });
});

describe('freee Web form submission guard', () => {
  it('does not treat a route change as submission confirmation', () => {
    expect(() => assertSubmissionConfirmed({ routeChanged: true })).toThrow(
      expect.objectContaining({ code: 'WEB_FORM_SUBMISSION_UNCONFIRMED' }),
    );
  });

  it('requires explicit success evidence bound to a trusted target', () => {
    expect(() => assertSubmissionConfirmed({
      successIndicator: true,
      targetConfirmed: true,
      trustedRoute: true,
    })).not.toThrow();

    for (const outcome of [
      { successIndicator: true },
      { successIndicator: true, targetConfirmed: true },
      { successIndicator: true, trustedRoute: true },
    ]) {
      expect(() => assertSubmissionConfirmed(outcome)).toThrow(
        expect.objectContaining({ code: 'WEB_FORM_SUBMISSION_UNCONFIRMED' }),
      );
    }
  });

  it('gives an explicit rejection priority over all success evidence', () => {
    expect(() => assertSubmissionConfirmed({
      successIndicator: true,
      errorIndicator: true,
      targetConfirmed: true,
      trustedRoute: true,
    })).toThrow(expect.objectContaining({ code: 'WEB_FORM_SUBMISSION_REJECTED' }));
  });
});

function createMonthlyClosingBot({
  renderedTarget = {
    requestType: MONTHLY_TYPE,
    year: 2026,
    month: 7,
  },
  finalUrl = MONTHLY_SUCCESS_URL,
  navigationUrl = MONTHLY_FORM_URL,
  bodyText = '\u7533\u8acb\u3057\u307e\u3057\u305f',
  mutationMonth = 7,
  waitError = null,
  guardError = null,
} = {}) {
  let currentUrl = MONTHLY_FORM_URL;
  const submitButton = {
    click: vi.fn(async () => {
      currentUrl = finalUrl;
    }),
    count: vi.fn(async () => 1),
  };
  const page = {
    evaluate: vi.fn(async (_fn, payload) => {
      if (payload?.kind === 'monthly-closing-target') return renderedTarget;
      return {
        successIndicator: payload.success.some((value) => bodyText.includes(value)),
        errorIndicator: payload.errors.some((value) => bodyText.includes(value)),
        acceptedIndicator: payload.accepted.some((value) => bodyText.includes(value)),
      };
    }),
    locator: vi.fn(() => ({
      filter: vi.fn(() => submitButton),
    })),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn(async () => {
      if (waitError) throw waitError;
    }),
  };
  const bot = {
    assertPreMutationGuard: vi.fn(async () => {
      if (guardError) throw guardError;
    }),
    navigateToSpaForm: vi.fn(async (url) => {
      currentUrl = navigationUrl || url;
    }),
    dispatchGuardedMutation: vi.fn(async (locator, { validateRequest }) => {
      validateRequest(mutationRequest({
        approval_request: {
          type: MONTHLY_TYPE,
          target_year: 2026,
          target_month: mutationMonth,
        },
      }));
      await bot.assertPreMutationGuard();
      await locator.click();
    }),
    page,
    takeScreenshots: vi.fn(() => ({
      before: vi.fn(async () => null),
      after: vi.fn(async () => null),
    })),
    waitForElement: vi.fn(async (predicate) => {
      expect(await predicate()).toBe(true);
    }),
  };
  return { bot, submitButton };
}

describe('monthly closing web form', () => {
  it('confirms success only from an explicit marker on a trusted route', async () => {
    const { bot, submitButton } = createMonthlyClosingBot();

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).resolves.toMatchObject({
      success: true,
      alreadySubmitted: false,
    });
    expect(submitButton.click).toHaveBeenCalledOnce();
  });

  it('does not click when the rendered request type or month is wrong', async () => {
    for (const renderedTarget of [
      { requestType: 'ApprovalRequest::WorkTime', year: 2026, month: 7 },
      { requestType: MONTHLY_TYPE, year: 2026, month: 8 },
    ]) {
      const { bot, submitButton } = createMonthlyClosingBot({ renderedTarget });
      await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
        code: 'WEB_FORM_TARGET_MISMATCH',
      });
      expect(submitButton.click).not.toHaveBeenCalled();
    }
  });

  it('does not click when the pre-mutation company guard becomes stale', async () => {
    const guardError = Object.assign(new Error('synthetic stale binding'), {
      code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
    });
    const { bot, submitButton } = createMonthlyClosingBot({ guardError });

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
    });
    expect(submitButton.click).not.toHaveBeenCalled();
  });

  it('does not click when the intercepted request targets another month', async () => {
    const { bot, submitButton } = createMonthlyClosingBot({ mutationMonth: 8 });
    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_MUTATION_REQUEST_UNTRUSTED',
    });
    expect(submitButton.click).not.toHaveBeenCalled();
  });

  it('does not click when the route identifies another request type', async () => {
    const { bot, submitButton } = createMonthlyClosingBot({
      navigationUrl: MONTHLY_FORM_URL.replace(
        MONTHLY_TYPE,
        'ApprovalRequest::WorkTime',
      ),
    });

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_FORM_TARGET_MISMATCH',
    });
    expect(submitButton.click).not.toHaveBeenCalled();
  });

  it('does not confirm from a route change alone', async () => {
    const { bot } = createMonthlyClosingBot({ bodyText: '' });
    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_FORM_SUBMISSION_UNCONFIRMED',
    });
  });

  it.each([
    'https://accounts.secure.freee.co.jp/login',
    'https://accounts.secure.freee.co.jp/login/mfa',
    'https://p.secure.freee.co.jp/companies',
    'https://p.secure.freee.co.jp/approval_requests#/error',
    'https://p.secure.freee.co.jp/approval_requests#/unexpected',
    'https://p.secure.freee.co.jp/approval_requests#/requests/error',
    'https://p.secure.freee.co.jp/approval_requests#/requests/unexpected',
    'https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::WorkTime',
  ])('fails closed after an untrusted redirect: %s', async (finalUrl) => {
    const { bot } = createMonthlyClosingBot({ finalUrl });
    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_FORM_SUBMISSION_UNCONFIRMED',
    });
  });

  it('treats an existing monthly request as idempotent success', async () => {
    const { bot } = createMonthlyClosingBot({
      finalUrl: MONTHLY_FORM_URL,
      bodyText: FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
    });

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).resolves.toMatchObject({
      success: true,
      alreadySubmitted: true,
    });
  });

  it('gives an explicit rejection priority over an accepted duplicate marker', async () => {
    const { bot } = createMonthlyClosingBot({
      finalUrl: MONTHLY_FORM_URL,
      bodyText: `${FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED}\n\u30a8\u30e9\u30fc`,
    });

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).rejects.toMatchObject({
      code: 'WEB_FORM_SUBMISSION_REJECTED',
    });
  });

  it('checks the final state even when the bounded wait expires', async () => {
    const { bot } = createMonthlyClosingBot({
      waitError: new Error('synthetic timeout'),
    });

    await expect(submitMonthlyClosingWeb(bot, 2026, 7)).resolves.toMatchObject({
      success: true,
      alreadySubmitted: false,
    });
  });

  it('does not include page content in an unconfirmed-submission error', async () => {
    const sensitiveMarker = 'synthetic-private-page-marker';
    const { bot } = createMonthlyClosingBot({
      finalUrl: MONTHLY_FORM_URL,
      bodyText: sensitiveMarker,
    });

    const error = await submitMonthlyClosingWeb(bot, 2026, 7).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'WEB_FORM_SUBMISSION_UNCONFIRMED' });
    expect(error.message).not.toContain(sensitiveMarker);
  });
});

function createWithdrawalBot({
  navigationUrl = WITHDRAWAL_URL,
  actionAttributes = {},
  finalUrl = WITHDRAWAL_URL,
  bodyText = '\u53d6\u308a\u4e0b\u3052\u6e08\u307f',
  domRequestId = null,
  domRequestType = null,
  mutationRequestId = WITHDRAWAL_ID,
  guardError = null,
} = {}) {
  let currentUrl = WITHDRAWAL_URL;
  const withdrawButton = {
    click: vi.fn(async () => {}),
    count: vi.fn(async () => 1),
    first: vi.fn(function first() { return this; }),
    getAttribute: vi.fn(async (name) => actionAttributes[name] ?? null),
  };
  const confirmButton = {
    click: vi.fn(async () => {
      currentUrl = finalUrl;
    }),
    count: vi.fn(async () => 1),
    first: vi.fn(function first() { return this; }),
    getAttribute: vi.fn(async () => null),
    waitFor: vi.fn(async () => {}),
  };
  let buttonFilterCalls = 0;
  const page = {
    evaluate: vi.fn(async (_fn, payload) => {
      if (payload?.kind === 'approval-request-target') {
        return { domRequestId, domRequestType };
      }
      return {
        successIndicator: payload.success.some((value) => bodyText.includes(value)),
        errorIndicator: payload.errors.some((value) => bodyText.includes(value)),
        acceptedIndicator: payload.accepted.some((value) => bodyText.includes(value)),
      };
    }),
    locator: vi.fn(() => ({
      filter: vi.fn(() => {
        buttonFilterCalls += 1;
        return buttonFilterCalls === 1 ? withdrawButton : confirmButton;
      }),
    })),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn(async () => {}),
  };
  const bot = {
    assertPreMutationGuard: vi.fn(async () => {
      if (guardError) throw guardError;
    }),
    checkSubmitResult: vi.fn(async () => ({ success: true })),
    navigateToSpaForm: vi.fn(async () => {
      currentUrl = navigationUrl;
    }),
    dispatchGuardedMutation: vi.fn(async (locator, { validateRequest }) => {
      validateRequest(mutationRequest({
        approval_request: {
          request_id: mutationRequestId,
          type: WITHDRAWAL_TYPE,
        },
      }, 'https://p.secure.freee.co.jp/api/private/employees/approval_requests/requests', 'DELETE'));
      await bot.assertPreMutationGuard();
      await locator.click();
    }),
    page,
    takeScreenshots: vi.fn(() => ({
      before: vi.fn(async () => null),
      after: vi.fn(async () => null),
    })),
    waitForElement: vi.fn(async (predicate) => {
      expect(await predicate()).toBe(true);
    }),
  };
  return { bot, confirmButton, withdrawButton };
}

describe('approval withdrawal target guard', () => {
  it('requires the requested id and type in the detail route', () => {
    expect(() => assertWithdrawalTarget({
      url: WITHDRAWAL_URL,
      actionCount: 1,
    }, WITHDRAWAL_ID, WITHDRAWAL_TYPE, { requireAction: true })).not.toThrow();

    expect(() => assertWithdrawalTarget({
      url: WITHDRAWAL_URL.replace(WITHDRAWAL_ID, '54321'),
      actionCount: 1,
    }, WITHDRAWAL_ID, WITHDRAWAL_TYPE, { requireAction: true })).toThrow(
      expect.objectContaining({ code: 'WEB_FORM_TARGET_MISMATCH' }),
    );
    expect(() => assertWithdrawalTarget({
      url: WITHDRAWAL_URL.replace(
        encodeURIComponent(WITHDRAWAL_TYPE),
        encodeURIComponent('ApprovalRequest::WorkTime'),
      ),
      actionCount: 1,
    }, WITHDRAWAL_ID, WITHDRAWAL_TYPE, { requireAction: true })).toThrow(
      expect.objectContaining({ code: 'WEB_FORM_TARGET_MISMATCH' }),
    );
  });

  it('does not click on a mismatched detail route', async () => {
    const { bot, confirmButton, withdrawButton } = createWithdrawalBot({
      navigationUrl: WITHDRAWAL_URL.replace(WITHDRAWAL_ID, '54321'),
    });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(withdrawButton.click).not.toHaveBeenCalled();
    expect(confirmButton.click).not.toHaveBeenCalled();
  });

  it('does not click an action explicitly bound to another request', async () => {
    const { bot, withdrawButton } = createWithdrawalBot({
      actionAttributes: {
        'data-approval-request-id': '54321',
        'data-approval-request-type': WITHDRAWAL_TYPE,
      },
    });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(withdrawButton.click).not.toHaveBeenCalled();
  });

  it('does not click a withdrawal link targeting another request', async () => {
    const { bot, withdrawButton } = createWithdrawalBot({
      actionAttributes: {
        href: WITHDRAWAL_URL.replace(WITHDRAWAL_ID, '54321'),
      },
    });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(withdrawButton.click).not.toHaveBeenCalled();
  });

  it('keeps a malformed withdrawal link failure generic', async () => {
    const malformedTarget = 'http://[';
    const { bot, withdrawButton } = createWithdrawalBot({
      actionAttributes: { href: malformedTarget },
    });

    const error = await withdrawApprovalRequest(
      bot,
      'PaidHoliday',
      WITHDRAWAL_ID,
    ).catch((caught) => caught);
    expect(error).toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
    expect(error.message).not.toContain(malformedTarget);
    expect(withdrawButton.click).not.toHaveBeenCalled();
  });

  it('confirms withdrawal only while still bound to the same target', async () => {
    const { bot, confirmButton, withdrawButton } = createWithdrawalBot();

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .resolves.toMatchObject({ success: true });
    expect(withdrawButton.click).toHaveBeenCalledOnce();
    expect(confirmButton.click).toHaveBeenCalledOnce();
  });

  it('does not begin withdrawal when the pre-mutation company guard becomes stale', async () => {
    const guardError = Object.assign(new Error('synthetic stale binding'), {
      code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
    });
    const { bot, confirmButton, withdrawButton } = createWithdrawalBot({ guardError });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED' });
    expect(withdrawButton.click).not.toHaveBeenCalled();
    expect(confirmButton.click).not.toHaveBeenCalled();
  });

  it('does not click when the intercepted request targets another approval', async () => {
    const { bot, confirmButton, withdrawButton } = createWithdrawalBot({
      mutationRequestId: '54321',
    });
    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_MUTATION_REQUEST_UNTRUSTED' });
    expect(withdrawButton.click).not.toHaveBeenCalled();
    expect(confirmButton.click).not.toHaveBeenCalled();
  });

  it('fails closed when the post-withdrawal route points at another request', async () => {
    const { bot } = createWithdrawalBot({
      finalUrl: WITHDRAWAL_URL.replace(WITHDRAWAL_ID, '54321'),
    });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_FORM_TARGET_MISMATCH' });
  });

  it('does not confirm the same target without an explicit withdrawal outcome', async () => {
    const { bot } = createWithdrawalBot({ bodyText: '' });

    await expect(withdrawApprovalRequest(bot, 'PaidHoliday', WITHDRAWAL_ID))
      .rejects.toMatchObject({ code: 'WEB_FORM_SUBMISSION_UNCONFIRMED' });
  });
});
