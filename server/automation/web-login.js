import { ACTION_SELECTORS } from "./constants.js";

const LOGIN_INPUT_SELECTOR = "input[name='loginId']";
const LOGIN_ERROR_SELECTOR =
  ".login-form__error, .error-message-text, [data-testid='login-error']";
const ACTION_SELECTOR = Object.values(ACTION_SELECTORS).join(", ");
const FREEE_WEB_APP_ORIGIN = "https://p.secure.freee.co.jp";
const FREEE_WEB_LOGIN_ORIGIN = "https://accounts.secure.freee.co.jp";
const FREEE_WEB_ALLOWED_ORIGINS = new Set([
  FREEE_WEB_APP_ORIGIN,
  FREEE_WEB_LOGIN_ORIGIN,
]);
const GUARDED_CONTEXTS = new WeakSet();

export const WEB_LOGIN_STATE = {
  AUTHENTICATED: "authenticated",
  LOGIN_REQUIRED: "login_required",
  INVALID_CREDENTIALS: "invalid_credentials",
  INTERACTION_REQUIRED: "interaction_required",
  UNCONFIRMED: "unconfirmed",
};

function webLoginError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parsedOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isAllowedFreeeWebUrl(value) {
  return FREEE_WEB_ALLOWED_ORIGINS.has(parsedOrigin(value));
}

export function assertAllowedFreeeWebUrl(
  value,
  {
    applicationOnly = false,
    code = "WEB_NAVIGATION_ORIGIN_BLOCKED",
  } = {},
) {
  const origin = parsedOrigin(value);
  const allowed = applicationOnly
    ? origin === FREEE_WEB_APP_ORIGIN
    : FREEE_WEB_ALLOWED_ORIGINS.has(origin);
  if (!allowed) {
    throw webLoginError(
      code,
      "Browser automation stopped because the page origin was not trusted.",
    );
  }
  return origin;
}

export async function installFreeeWebNavigationGuard(context) {
  if (!context || typeof context.route !== "function") {
    throw webLoginError(
      "WEB_NAVIGATION_GUARD_UNAVAILABLE",
      "Browser automation stopped because the navigation guard was unavailable.",
    );
  }
  if (GUARDED_CONTEXTS.has(context)) return;

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();

    let topLevelNavigation;
    try {
      topLevelNavigation = request.frame().parentFrame() === null;
    } catch {
      return route.abort("blockedbyclient");
    }
    if (topLevelNavigation && !isAllowedFreeeWebUrl(request.url())) {
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  GUARDED_CONTEXTS.add(context);
}

export function classifyFreeeWebLoginSnapshot({
  url = "",
  hasAttendanceUi = false,
  hasLoginForm = false,
  hasLoginError = false,
  bodyText = "",
} = {}) {
  const origin = url ? parsedOrigin(url) : null;
  if (url && !FREEE_WEB_ALLOWED_ORIGINS.has(origin)) {
    return WEB_LOGIN_STATE.UNCONFIRMED;
  }
  if (hasAttendanceUi && origin === FREEE_WEB_APP_ORIGIN) {
    return WEB_LOGIN_STATE.AUTHENTICATED;
  }

  const interactionRequired =
    /\/(?:two[_-]?factor|mfa|verification|challenge)(?:\/|$|[?#])/i.test(url) ||
    bodyText.includes("二要素認証") ||
    bodyText.includes("確認コード") ||
    bodyText.includes("認証コード");
  if (interactionRequired) return WEB_LOGIN_STATE.INTERACTION_REQUIRED;

  const invalidCredentials =
    hasLoginError ||
    bodyText.includes("ログインできませんでした") ||
    bodyText.includes("メールアドレスまたはパスワードが正しくありません") ||
    bodyText.includes("ログイン情報が正しくありません") ||
    bodyText.includes("アカウントがロック") ||
    bodyText.includes("Invalid login") ||
    bodyText.includes("incorrect password");
  if (invalidCredentials) return WEB_LOGIN_STATE.INVALID_CREDENTIALS;
  if (hasLoginForm) return WEB_LOGIN_STATE.LOGIN_REQUIRED;
  return WEB_LOGIN_STATE.UNCONFIRMED;
}

async function isVisible(locator) {
  return (await locator.count()) > 0 && locator.isVisible().catch(() => false);
}

async function inspectFreeeWebLogin(page) {
  const loginInput = page.locator(LOGIN_INPUT_SELECTOR);
  const loginError = page.locator(LOGIN_ERROR_SELECTOR).first();
  const attendanceUi = page.locator(ACTION_SELECTOR).first();
  const [hasLoginForm, hasLoginError, hasAttendanceUi, bodyText] =
    await Promise.all([
      isVisible(loginInput),
      isVisible(loginError),
      isVisible(attendanceUi),
      page
        .evaluate(() => document.body.innerText.substring(0, 2000))
        .catch(() => ""),
    ]);

  return {
    state: classifyFreeeWebLoginSnapshot({
      url: page.url(),
      hasAttendanceUi,
      hasLoginForm,
      hasLoginError,
      bodyText,
    }),
    loginInput,
  };
}

function throwForLoginState(state) {
  if (state === WEB_LOGIN_STATE.INVALID_CREDENTIALS) {
    throw webLoginError(
      "WEB_LOGIN_FAILED",
      "freee Web rejected the configured credentials. Update them in Settings.",
    );
  }
  if (state === WEB_LOGIN_STATE.INTERACTION_REQUIRED) {
    throw webLoginError(
      "WEB_LOGIN_INTERACTION_REQUIRED",
      "freee Web requires an interactive verification step before automation can continue.",
    );
  }
  throw webLoginError(
    "WEB_LOGIN_UNCONFIRMED",
    "freee Web login could not be confirmed from a known authenticated page state.",
  );
}

export async function authenticateFreeeWeb(page, { username, password }) {
  await page.goto("https://p.secure.freee.co.jp/", {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page
    .waitForSelector(`${LOGIN_INPUT_SELECTOR}, ${ACTION_SELECTOR}`, {
      state: "attached",
      timeout: 15_000,
    })
    .catch(() => {});

  assertAllowedFreeeWebUrl(page.url(), {
    code: "WEB_LOGIN_ORIGIN_UNTRUSTED",
  });
  const initial = await inspectFreeeWebLogin(page);
  if (initial.state === WEB_LOGIN_STATE.AUTHENTICATED) {
    return { restored: true };
  }
  if (initial.state !== WEB_LOGIN_STATE.LOGIN_REQUIRED) {
    throwForLoginState(initial.state);
  }

  assertAllowedFreeeWebUrl(page.url(), {
    code: "WEB_LOGIN_ORIGIN_UNTRUSTED",
  });
  await initial.loginInput.fill(username);
  assertAllowedFreeeWebUrl(page.url(), {
    code: "WEB_LOGIN_ORIGIN_UNTRUSTED",
  });
  await page.fill("input[name='password']", password);
  assertAllowedFreeeWebUrl(page.url(), {
    code: "WEB_LOGIN_ORIGIN_UNTRUSTED",
  });
  await page.click("button[type='submit']");
  await page
    .waitForFunction(
      ({ loginSelector, actionSelector, errorSelector }) => {
        const loginInput = document.querySelector(loginSelector);
        const actionButton = document.querySelector(actionSelector);
        const loginError = document.querySelector(errorSelector);
        const text = document.body.innerText;
        const interactionRequired =
          text.includes("二要素認証") ||
          text.includes("確認コード") ||
          text.includes("認証コード");
        return !loginInput || actionButton || loginError || interactionRequired;
      },
      {
        loginSelector: LOGIN_INPUT_SELECTOR,
        actionSelector: ACTION_SELECTOR,
        errorSelector: LOGIN_ERROR_SELECTOR,
      },
      { timeout: 15_000 },
    )
    .catch(() => {});

  assertAllowedFreeeWebUrl(page.url(), {
    code: "WEB_LOGIN_ORIGIN_UNTRUSTED",
  });
  const final = await inspectFreeeWebLogin(page);
  if (final.state === WEB_LOGIN_STATE.AUTHENTICATED) {
    return { restored: false };
  }
  throwForLoginState(final.state);
}
