import { describe, expect, it, vi } from 'vitest';

import { FREEE_STATE } from '../server/constants.js';
import { ACTION_SELECTORS } from '../server/automation/constants.js';
import { PunchBot } from '../server/automation/punch-bot.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function timeClockResponse({
  ok = true,
  url = 'https://p.secure.freee.co.jp/api/private/employee_portal/time_clocks',
  body = null,
} = {}) {
  let requestBody = body;
  const actionTypes = {
    checkin: 'clock_in',
    checkout: 'clock_out',
    break_start: 'break_begin',
    break_end: 'break_end',
  };
  const request = {
    method: vi.fn(() => 'POST'),
    url: vi.fn(() => url),
    postDataBuffer: vi.fn(() => Buffer.from(JSON.stringify(requestBody), 'utf8')),
    postData: vi.fn(() => JSON.stringify(requestBody)),
    postDataJSON: vi.fn(() => requestBody),
  };
  return {
    ok: vi.fn(() => ok),
    request: vi.fn(() => request),
    url: vi.fn(() => url),
    setAction(actionType) {
      if (body === null) requestBody = { type: actionTypes[actionType] };
    },
  };
}

function createActionPage(initial = {}, onClick = () => {}, response = timeClockResponse()) {
  const state = { ...initial };
  const route = {
    abort: vi.fn(async () => {}),
    continue: vi.fn(async () => {}),
  };
  let routeRegistration = null;
  let resolveObservedResponse;
  const observedResponse = response === null
    ? Promise.resolve(null)
    : new Promise((resolve) => {
      resolveObservedResponse = resolve;
    });

  function locatorFor(selector) {
    const api = {
      count: vi.fn(async () => (selector in state ? 1 : 0)),
      isVisible: vi.fn(async () => Boolean(state[selector]?.visible)),
      isEnabled: vi.fn(async () => Boolean(state[selector]?.enabled)),
      click: vi.fn(async () => {
        const actionType = Object.entries(ACTION_SELECTORS)
          .find(([, actionSelector]) => actionSelector === selector)?.[0];
        response?.setAction?.(actionType);
        const request = response?.request?.();
        const requestUrl = request?.url?.() || response?.url?.();
        const matches = routeRegistration && requestUrl
          ? routeRegistration.matcher(new URL(requestUrl))
          : false;
        if (matches) {
          await routeRegistration.handler(route, request);
          if (route.abort.mock.calls.length > 0) return;
        }
        if (response) resolveObservedResponse(response);
        return onClick(selector, state);
      }),
      scrollIntoViewIfNeeded: vi.fn(async () => {}),
      first: vi.fn(() => api),
    };
    return api;
  }

  return {
    state,
    route,
    page: {
      url: vi.fn(() => 'https://p.secure.freee.co.jp/'),
      locator: vi.fn(locatorFor),
      route: vi.fn(async (matcher, handler, options) => {
        routeRegistration = { matcher, handler, options };
      }),
      unroute: vi.fn(async (matcher, handler) => {
        if (
          routeRegistration?.matcher === matcher &&
          routeRegistration?.handler === handler
        ) {
          routeRegistration = null;
        }
      }),
      waitForSelector: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      waitForResponse: vi.fn(async (predicate) => {
        const observed = await observedResponse;
        if (!observed || !predicate(observed)) throw new Error('No matching response');
        return observed;
      }),
    },
  };
}

function createConcurrentMutationHarness(requests) {
  let routeHandler = null;
  const routes = requests.map(() => ({
    abort: vi.fn(async () => {}),
    continue: vi.fn(async () => {}),
  }));
  const page = {
    url: vi.fn(() => 'https://p.secure.freee.co.jp/'),
    route: vi.fn(async (_matcher, handler) => {
      routeHandler = handler;
      return { dispose: vi.fn(async () => {}) };
    }),
  };
  const locator = {
    click: vi.fn(async () => {
      await Promise.all(requests.map((request, index) =>
        routeHandler(routes[index], request)));
    }),
  };
  return { page, locator, routes };
}

describe('PunchBot state and action confirmation', () => {
  it('closes a late initialization context after the operation aborts', async () => {
    const pendingContext = deferred();
    const context = {
      browser: vi.fn(() => null),
      newPage: vi.fn(),
    };
    const runtime = {
      closeBrowser: vi.fn(async () => {}),
      closeContext: vi.fn(async () => {}),
      openContext: vi.fn(() => pendingContext.promise),
    };
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error('synthetic timeout'), {
      code: 'AUTOMATION_OPERATION_TIMEOUT',
    });
    const bot = new PunchBot({ runtime });

    const initialization = bot.init(controller.signal);
    await vi.waitFor(() => expect(runtime.openContext).toHaveBeenCalledWith({
      signal: controller.signal,
    }));
    controller.abort(timeoutError);
    await vi.waitFor(() => expect(runtime.closeBrowser).toHaveBeenCalledOnce());
    pendingContext.resolve(context);

    await expect(initialization).rejects.toBe(timeoutError);
    expect(runtime.closeContext).toHaveBeenCalledWith(context);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(bot.context).toBeNull();
  });

  it('rejects screenshot capture without an operation-bound identity', async () => {
    const previous = process.env.BROWSER_SCREENSHOTS;
    process.env.BROWSER_SCREENSHOTS = 'all';
    try {
      const bot = new PunchBot();
      await expect(bot.captureScreenshot('fixture', 'before')).rejects.toMatchObject({
        code: 'SCREENSHOT_IDENTITY_UNBOUND',
      });
    } finally {
      if (previous === undefined) delete process.env.BROWSER_SCREENSHOTS;
      else process.env.BROWSER_SCREENSHOTS = previous;
    }
  });

  it('fails closed when Web automation has no explicit company target', async () => {
    const bot = new PunchBot();
    await expect(bot.ensureCompany('')).rejects.toMatchObject({
      code: 'WEB_COMPANY_TARGET_REQUIRED',
    });
  });

  it('matches the configured company name exactly', async () => {
    let targetPattern = null;
    const activeTarget = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      first() { return this; },
    };
    const headerControls = {
      filter: vi.fn(({ hasText }) => {
        targetPattern = hasText;
        return activeTarget;
      }),
    };
    const bot = new PunchBot();
    bot.page = {
      url: vi.fn(() => 'https://p.secure.freee.co.jp/'),
      locator: vi.fn(() => ({ locator: () => headerControls })),
    };

    await expect(bot.ensureCompany('Example (Primary)')).resolves.toBeUndefined();
    expect(targetPattern.test('Example (Primary)')).toBe(true);
    expect(targetPattern.test('Example (Primary) 2')).toBe(false);
  });

  it('asserts the active company without clicking or switching', async () => {
    const activeTarget = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      first() { return this; },
      click: vi.fn(),
    };
    const headerControls = {
      filter: vi.fn(() => activeTarget),
    };
    const bot = new PunchBot();
    bot.page = {
      url: vi.fn(() => 'https://p.secure.freee.co.jp/'),
      locator: vi.fn(() => ({ locator: () => headerControls })),
    };

    await expect(bot.assertCompanyActive('Example Corp')).resolves.toBeUndefined();
    expect(activeTarget.click).not.toHaveBeenCalled();
  });

  it('does not return inspected page content from submission checks', async () => {
    const privateMarker = 'synthetic-private-page-marker';
    const bot = new PunchBot();
    bot.page = { evaluate: vi.fn(async () => privateMarker) };

    const result = await bot.checkSubmitResult();
    expect(result).toEqual({ success: true });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it('treats an unrecognized or empty attendance page as unknown', async () => {
    const { page } = createActionPage();
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.detectState()).resolves.toBe(FREEE_STATE.UNKNOWN);
  });

  it('detects working state only from a visible enabled action', async () => {
    const { page } = createActionPage({
      [ACTION_SELECTORS.checkout]: { visible: true, enabled: true },
    });
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.detectState()).resolves.toBe(FREEE_STATE.WORKING);
  });

  it('accepts a punch only after the expected next state is visible', async () => {
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      (selector, state) => {
        if (selector !== ACTION_SELECTORS.checkin) return;
        delete state[ACTION_SELECTORS.checkin];
        state[ACTION_SELECTORS.checkout] = { visible: true, enabled: true };
      },
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic'))
      .resolves.toMatchObject({ screenshotBefore: null, screenshotAfter: null });
    expect(page.route).toHaveBeenCalledWith(expect.any(Function), expect.any(Function));
    expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.abort).not.toHaveBeenCalled();
  });

  it('does not click when the pre-mutation guard rejects the company binding', async () => {
    const clickAttempt = vi.fn();
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    const bot = new PunchBot();
    bot.page = page;
    bot.setPreMutationGuard(async () => {
      throw Object.assign(new Error('synthetic stale company binding'), {
        code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
      });
    });

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_COMPANY_IDENTITY_UNCONFIRMED',
    });
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('aborts the exact mutation request when the final dispatch guard becomes stale', async () => {
    const clickAttempt = vi.fn();
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    const bot = new PunchBot();
    bot.page = page;
    const preMutationGuard = vi.fn(async () => {});
    const authorizationGuard = vi.fn(() => {
      if (authorizationGuard.mock.calls.length === 2) {
        throw Object.assign(new Error('synthetic stale schedule generation'), {
          code: 'SCHEDULE_GENERATION_STALE',
        });
      }
    });
    bot.setPreMutationGuard(preMutationGuard, authorizationGuard);

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'SCHEDULE_GENERATION_STALE',
    });
    expect(preMutationGuard).toHaveBeenCalledTimes(2);
    expect(authorizationGuard).toHaveBeenCalledTimes(2);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('blocks an unknown state-changing request before it can leave the page', async () => {
    const clickAttempt = vi.fn();
    const response = timeClockResponse({
      url: 'https://p.secure.freee.co.jp/api/private/employee_portal/new_time_clocks',
    });
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
      response,
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_REQUEST_UNTRUSTED',
    });
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['another action', { type: 'clock_out' }],
    ['another employee', { type: 'clock_in', employee_id: 2002 }],
    ['another date', { type: 'clock_in', base_date: '2026-07-14' }],
  ])('aborts an attendance payload bound to %s', async (_label, body) => {
    const clickAttempt = vi.fn();
    const response = timeClockResponse({ body });
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
      response,
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic', {
      employeeId: '1001',
      date: '2026-07-13',
    })).rejects.toMatchObject({ code: 'WEB_MUTATION_REQUEST_UNTRUSTED' });
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['two matching requests', [true, true]],
    ['one matching and one rejected request', [true, false]],
  ])('aborts every in-flight mutation when a click emits %s', async (_label, validity) => {
    const requests = validity.map((valid) => ({
      method: vi.fn(() => 'POST'),
      valid,
    }));
    const { page, locator, routes } = createConcurrentMutationHarness(requests);
    const guardEntered = deferred();
    const releaseGuard = deferred();
    const bot = new PunchBot();
    bot.page = page;
    bot.setPreMutationGuard(vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        guardEntered.resolve();
        await releaseGuard.promise;
      }));

    const operation = bot.dispatchGuardedMutation(locator, {
      validateRequest: (request) => {
        if (request.valid) return true;
        throw Object.assign(new Error('rejected request'), {
          code: 'WEB_MUTATION_REQUEST_UNTRUSTED',
        });
      },
    });
    await guardEntered.promise;
    releaseGuard.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'WEB_MUTATION_REQUEST_UNTRUSTED',
    });
    for (const route of routes) {
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
      expect(route.continue).not.toHaveBeenCalled();
    }
  });

  it('allows one DELETE mutation only when its validator accepts the request', async () => {
    const request = { method: vi.fn(() => 'DELETE') };
    const { page, locator, routes } = createConcurrentMutationHarness([request]);
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.dispatchGuardedMutation(locator, {
      validateRequest: (candidate) => {
        expect(candidate.method()).toBe('DELETE');
        return true;
      },
    })).resolves.toMatchObject({ request });
    expect(routes[0].continue).toHaveBeenCalledOnce();
    expect(routes[0].abort).not.toHaveBeenCalled();
  });

  it('fails closed before clicking when request routing is unavailable', async () => {
    const clickAttempt = vi.fn();
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    delete page.route;
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE',
    });
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('keeps a timed-out routed request blocked after an asynchronous guard resumes', async () => {
    const delayedGuard = deferred();
    const clickAttempt = vi.fn();
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    page.waitForResponse.mockResolvedValue(null);
    const bot = new PunchBot();
    bot.page = page;
    const preMutationGuard = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(delayedGuard.promise);
    bot.setPreMutationGuard(preMutationGuard);

    const operation = bot.clickAction('checkin', 'synthetic');
    await vi.waitFor(() => {
      expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    });
    delayedGuard.resolve();

    await expect(operation).rejects.toMatchObject({
      code: 'WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE',
    });
    expect(route.continue).not.toHaveBeenCalled();
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('rejects an asynchronous final authorization guard before dispatch', async () => {
    const clickAttempt = vi.fn();
    const { page, route } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    const bot = new PunchBot();
    bot.page = page;
    bot.setPreMutationGuard(vi.fn(), async () => true);

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_DISPATCH_GUARD_ASYNC',
    });
    expect(page.route).not.toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('does not click a mutation control after navigation leaves the freee app origin', async () => {
    const clickAttempt = vi.fn();
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    page.url.mockReturnValue('https://example.invalid/attendance');
    const bot = new PunchBot();
    bot.page = page;
    bot.setPreMutationGuard(vi.fn());

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_ORIGIN_UNTRUSTED',
    });
    expect(clickAttempt).not.toHaveBeenCalled();
  });

  it('rejects an untrusted SPA form target before navigation', async () => {
    const bot = new PunchBot();
    bot.page = {
      url: vi.fn(() => 'https://p.secure.freee.co.jp/'),
      goto: vi.fn(),
      evaluate: vi.fn(),
      waitForTimeout: vi.fn(),
    };

    await expect(bot.navigateToSpaForm('https://example.invalid/form'))
      .rejects.toMatchObject({ code: 'WEB_NAVIGATION_ORIGIN_BLOCKED' });
    expect(bot.page.goto).not.toHaveBeenCalled();
    expect(bot.page.evaluate).not.toHaveBeenCalled();
  });

  it('fails closed when a click does not produce the expected state', async () => {
    const { page } = createActionPage({
      [ACTION_SELECTORS.checkin]: { visible: true, enabled: true },
    });
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_ACTION_CONFIRMATION_UNAVAILABLE',
    });
  });

  it('accepts checkout with no next button only after freee confirms the write', async () => {
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkout]: { visible: true, enabled: true } },
      (selector, state) => delete state[selector],
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkout', 'synthetic'))
      .resolves.toMatchObject({ screenshotBefore: null, screenshotAfter: null });
  });

  it('does not infer checkout success from an empty page without a confirmed write', async () => {
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkout]: { visible: true, enabled: true } },
      (selector, state) => delete state[selector],
      null,
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkout', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_DISPATCH_GUARD_UNAVAILABLE',
    });
  });

  it('does not trust a matching mutation path from another origin', async () => {
    const response = timeClockResponse({
      url: 'https://example.invalid/api/private/employee_portal/time_clocks',
    });
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      () => {},
      response,
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic')).rejects.toMatchObject({
      code: 'WEB_MUTATION_REQUEST_UNTRUSTED',
    });
  });

  it('does not repeat an ambiguous state-changing click', async () => {
    const clickAttempt = vi.fn((selector, state) => {
      delete state[selector];
      state[ACTION_SELECTORS.checkout] = { visible: true, enabled: true };
      throw new Error('page changed after dispatch');
    });
    const { page } = createActionPage(
      { [ACTION_SELECTORS.checkin]: { visible: true, enabled: true } },
      clickAttempt,
    );
    const bot = new PunchBot();
    bot.page = page;

    await expect(bot.clickAction('checkin', 'synthetic')).resolves.toMatchObject({
      screenshotBefore: null,
      screenshotAfter: null,
    });
    expect(clickAttempt).toHaveBeenCalledTimes(1);
  });
});
