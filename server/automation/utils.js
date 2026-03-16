import { getSetting } from "../db.js";
import { decrypt } from "../crypto.js";

/**
 * Get freee login credentials (GUI config takes priority over env)
 */
export function getCredentials() {
  const dbUsernameEnc = getSetting("freee_username_encrypted");
  const dbPasswordEnc = getSetting("freee_password_encrypted");

  if (dbUsernameEnc && dbPasswordEnc) {
    const username = decrypt(dbUsernameEnc);
    const password = decrypt(dbPasswordEnc);
    if (username && password) {
      return { username, password };
    }
  }

  // Fallback to environment variables
  return {
    username: process.env.LOGIN_USERNAME || "",
    password: process.env.LOGIN_PASSWORD || "",
  };
}

/** Get the active connection mode — always 'api' now (browser mode disabled) */
export function getConnectionMode() {
  return getSetting("connection_mode") || "api";
}

/** Check if credentials are configured — API (OAuth) only */
export function hasCredentials() {
  return getSetting("oauth_configured") === "1";
}

/** Check if debug/mock mode is enabled */
export function isDebugMode() {
  return getSetting("debug_mode") === "1";
}

/** Check if freee Web credentials are configured */
export function hasWebCredentials() {
  const creds = getCredentials();
  return !!(creds.username && creds.password);
}
