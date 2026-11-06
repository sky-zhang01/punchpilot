import { getSetting } from "../db.js";
import { decrypt } from "../crypto.js";
import { resolveWebAccount } from "../web-account.js";

/**
 * Get freee login credentials (GUI config takes priority over env)
 */
export function getWebAccountSnapshot() {
  return resolveWebAccount(getSetting, decrypt);
}

export function getCredentials() {
  const account = getWebAccountSnapshot();
  if (account.code) {
    const error = new Error('Web credentials are incomplete or inconsistent; save or verify the account again.');
    error.code = account.code;
    throw error;
  }
  return { username: account.username, password: account.password };
}

/** Get the active connection mode. Browser mode remains supported for API-less accounts. */
export function getConnectionMode() {
  return getSetting("connection_mode") || "api";
}

/** Check whether OAuth credentials are configured for API reads or actions. */
export function hasApiCredentials() {
  return getSetting("oauth_configured") === "1";
}

/** Check credentials for the currently selected action transport. */
export function hasCredentials() {
  return getConnectionMode() === "browser"
    ? hasWebCredentials()
    : hasApiCredentials();
}

/** Check if debug/mock mode is enabled */
export function isDebugMode() {
  return getSetting("debug_mode") === "1";
}

/** Check if freee Web credentials are configured */
export function hasWebCredentials() {
  return getWebAccountSnapshot().valid;
}

/** Resolve the exact company name that Web automation must confirm before writes. */
export function getWebCompanyName() {
  return getWebAccountSnapshot().companyName;
}
