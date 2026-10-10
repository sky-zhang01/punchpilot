import crypto from "node:crypto";
import { getSetting } from "../db.js";
import { getWebAccountSnapshot } from "./utils.js";

const IDENTITY_VERSION = "v1";

function normalizedGeneration(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function digestIdentity(parts) {
  const digest = crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex");
  return `${IDENTITY_VERSION}:${digest}`;
}

export function nextIdentityGeneration(settingKey) {
  const current = normalizedGeneration(getSetting(settingKey));
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Identity generation exhausted for ${settingKey}`);
  }
  return String(current + 1);
}

export function getOAuthIdentityGeneration() {
  return String(normalizedGeneration(getSetting("oauth_identity_generation")));
}

export function captureWebAccountBinding() {
  const { companyName, source, employeeId, credentialIdentity } = getWebAccountSnapshot();
  const generation = String(
    normalizedGeneration(getSetting("web_identity_generation")),
  );
  return Object.freeze({
    companyName,
    employeeId,
    generation,
    fingerprint: digestIdentity([
      "web-account",
      source,
      generation,
      companyName,
      employeeId,
      credentialIdentity,
    ]),
  });
}

export function isWebAccountVerified() {
  const account = getWebAccountSnapshot();
  return account.valid && Boolean(account.companyName && account.employeeId);
}

export function assertWebAccountBinding(binding) {
  const current = captureWebAccountBinding();
  if (
    !binding ||
    binding.fingerprint !== current.fingerprint ||
    binding.companyName !== current.companyName ||
    binding.employeeId !== current.employeeId ||
    binding.generation !== current.generation
  ) {
    const error = new Error(
      "The configured freee Web account changed during automation.",
    );
    error.code = "WEB_ACCOUNT_IDENTITY_CHANGED";
    throw error;
  }
  return current;
}

export function currentAutomationIdentityKey() {
  const mode = getSetting("connection_mode") || "api";
  const debugMode = getSetting("debug_mode") === "1" ? "debug" : "live";
  if (mode === "browser") {
    const web = captureWebAccountBinding();
    return digestIdentity([
      "automation",
      debugMode,
      "browser",
      web.fingerprint,
    ]);
  }
  return digestIdentity([
    "automation",
    debugMode,
    "api",
    getOAuthIdentityGeneration(),
    getSetting("oauth_company_id") || "",
    getSetting("oauth_employee_id") || "",
  ]);
}

export function captureAutomationOperationBinding() {
  const mode = getSetting("connection_mode") || "api";
  const debugMode = getSetting("debug_mode") === "1";
  return Object.freeze({
    mode,
    debugMode,
    identityKey: currentAutomationIdentityKey(),
  });
}

export function assertAutomationOperationBinding(binding) {
  const current = captureAutomationOperationBinding();
  if (
    !binding ||
    binding.mode !== current.mode ||
    binding.debugMode !== current.debugMode ||
    binding.identityKey !== current.identityKey
  ) {
    const error = new Error(
      "The automation account identity changed before the operation started.",
    );
    error.code = "AUTOMATION_IDENTITY_CHANGED";
    throw error;
  }
  return current;
}
