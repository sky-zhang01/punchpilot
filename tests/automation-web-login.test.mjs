import { describe, expect, it, vi } from 'vitest';

import {
  assertAllowedFreeeWebUrl,
  authenticateFreeeWeb,
  classifyFreeeWebLoginSnapshot,
  installFreeeWebNavigationGuard,
  isAllowedFreeeWebUrl,
  WEB_LOGIN_STATE,
} from '../server/automation/web-login.js';

describe('freee Web login state classification', () => {
  it('requires an explicit attendance marker before declaring authentication', () => {
    expect(classifyFreeeWebLoginSnapshot({
      url: 'https://p.secure.freee.co.jp/',
      hasAttendanceUi: true,
    })).toBe(WEB_LOGIN_STATE.AUTHENTICATED);

    expect(classifyFreeeWebLoginSnapshot({
      url: 'https://p.secure.freee.co.jp/unexpected',
    })).toBe(WEB_LOGIN_STATE.UNCONFIRMED);

    expect(classifyFreeeWebLoginSnapshot({
      url: 'https://example.invalid/unexpected',
      hasAttendanceUi: true,
    })).toBe(WEB_LOGIN_STATE.UNCONFIRMED);
  });

  it('distinguishes login, explicit rejection, and interactive verification', () => {
    expect(classifyFreeeWebLoginSnapshot({ hasLoginForm: true }))
      .toBe(WEB_LOGIN_STATE.LOGIN_REQUIRED);
    expect(classifyFreeeWebLoginSnapshot({ hasLoginError: true }))
      .toBe(WEB_LOGIN_STATE.INVALID_CREDENTIALS);
    expect(classifyFreeeWebLoginSnapshot({
      url: 'https://accounts.secure.freee.co.jp/mfa/challenge',
    })).toBe(WEB_LOGIN_STATE.INTERACTION_REQUIRED);
  });

  it('never exposes page content through the state value', () => {
    const privateMarker = 'synthetic-private-login-marker';
    const state = classifyFreeeWebLoginSnapshot({ bodyText: privateMarker });
    expect(state).toBe(WEB_LOGIN_STATE.UNCONFIRMED);
    expect(state).not.toContain(privateMarker);
  });

  it('accepts only the exact freee application and account origins', () => {
    expect(isAllowedFreeeWebUrl('https://p.secure.freee.co.jp/')).toBe(true);
    expect(isAllowedFreeeWebUrl('https://accounts.secure.freee.co.jp/sessions/new'))
      .toBe(true);
    expect(isAllowedFreeeWebUrl('http://p.secure.freee.co.jp/')).toBe(false);
    expect(isAllowedFreeeWebUrl('https://p.secure.freee.co.jp.example.invalid/'))
      .toBe(false);
    expect(() => assertAllowedFreeeWebUrl(
      'https://accounts.secure.freee.co.jp/sessions/new',
      { applicationOnly: true },
    )).toThrow(/origin was not trusted/);
  });

  it('blocks only untrusted top-level navigation', async () => {
    let handler;
    const context = {
      route: vi.fn(async (_pattern, callback) => { handler = callback; }),
    };
    await installFreeeWebNavigationGuard(context);
    await installFreeeWebNavigationGuard(context);
    expect(context.route).toHaveBeenCalledOnce();

    const blocked = {
      request: () => ({
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null }),
        url: () => 'https://example.invalid/login',
      }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await handler(blocked);
    expect(blocked.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(blocked.continue).not.toHaveBeenCalled();

    const trusted = {
      request: () => ({
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => null }),
        url: () => 'https://p.secure.freee.co.jp/',
      }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await handler(trusted);
    expect(trusted.continue).toHaveBeenCalledOnce();

    const childFrame = {};
    const subframe = {
      request: () => ({
        isNavigationRequest: () => true,
        frame: () => ({ parentFrame: () => childFrame }),
        url: () => 'https://example.invalid/frame',
      }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await handler(subframe);
    expect(subframe.continue).toHaveBeenCalledOnce();

    const resource = {
      request: () => ({ isNavigationRequest: () => false }),
      abort: vi.fn(),
      continue: vi.fn(),
    };
    await handler(resource);
    expect(resource.continue).toHaveBeenCalledOnce();
  });

  it('never fills credentials after an untrusted redirect', async () => {
    const loginInput = {
      count: vi.fn(async () => 1),
      isVisible: vi.fn(async () => true),
      fill: vi.fn(),
    };
    const absent = {
      count: vi.fn(async () => 0),
      isVisible: vi.fn(async () => false),
      first() { return this; },
    };
    const page = {
      goto: vi.fn(async () => {}),
      waitForSelector: vi.fn(async () => {}),
      url: vi.fn(() => 'https://example.invalid/login'),
      locator: vi.fn((selector) => {
        if (selector === "input[name='loginId']") return loginInput;
        return absent;
      }),
      evaluate: vi.fn(async () => ''),
      fill: vi.fn(),
      click: vi.fn(),
    };

    await expect(authenticateFreeeWeb(page, {
      username: 'synthetic-user',
      password: 'synthetic-password',
    })).rejects.toMatchObject({ code: 'WEB_LOGIN_ORIGIN_UNTRUSTED' });
    expect(loginInput.fill).not.toHaveBeenCalled();
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });
});
