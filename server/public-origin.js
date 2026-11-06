const OAUTH_CALLBACK_PATH = '/api/config/oauth-callback';

export class PublicOriginConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicOriginConfigurationError';
    this.code = 'PUBLIC_ORIGIN_CONFIGURATION_INVALID';
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]';
}

function parseConfiguredUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicOriginConfigurationError(`${label} must be an absolute URL`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new PublicOriginConfigurationError(`${label} contains unsupported URL components`);
  }
  if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
    throw new PublicOriginConfigurationError(`${label} must use HTTPS outside loopback`);
  }
  return parsed;
}

function configuredPublicOrigin() {
  const value = process.env.PUNCHPILOT_PUBLIC_ORIGIN?.trim();
  if (!value) return null;
  const parsed = parseConfiguredUrl(value, 'PUNCHPILOT_PUBLIC_ORIGIN');
  if (parsed.pathname !== '/' || parsed.search) {
    throw new PublicOriginConfigurationError(
      'PUNCHPILOT_PUBLIC_ORIGIN must contain only an origin',
    );
  }
  return parsed.origin;
}

function configuredOAuthRedirectUri() {
  const value = process.env.OAUTH_REDIRECT_URI?.trim();
  if (!value) return null;
  const parsed = parseConfiguredUrl(value, 'OAUTH_REDIRECT_URI');
  if (parsed.pathname !== OAUTH_CALLBACK_PATH || parsed.search) {
    throw new PublicOriginConfigurationError(
      `OAUTH_REDIRECT_URI must use the ${OAUTH_CALLBACK_PATH} callback path`,
    );
  }
  return parsed.toString();
}

export function getRequestOrigin(req) {
  const protocol = req?.protocol;
  const host = req?.get?.('host');
  if (!['http', 'https'].includes(protocol) || typeof host !== 'string' || !host) {
    return null;
  }
  try {
    const parsed = new URL(`${protocol}://${host}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function normalizeOriginHeader(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function resolvePublicOrigin(req) {
  const publicOrigin = configuredPublicOrigin();
  const redirectUri = configuredOAuthRedirectUri();
  const redirectOrigin = redirectUri ? new URL(redirectUri).origin : null;
  if (publicOrigin && redirectOrigin && publicOrigin !== redirectOrigin) {
    throw new PublicOriginConfigurationError(
      'PUNCHPILOT_PUBLIC_ORIGIN and OAUTH_REDIRECT_URI must use the same origin',
    );
  }
  if (publicOrigin || redirectOrigin) return publicOrigin || redirectOrigin;

  const requestOrigin = getRequestOrigin(req);
  if (!requestOrigin) return null;
  return isLoopbackHostname(new URL(requestOrigin).hostname) ? requestOrigin : null;
}

export function requestUsesSecureTransport(req) {
  const publicOrigin = resolvePublicOrigin(req);
  if (publicOrigin) return new URL(publicOrigin).protocol === 'https:';
  return req?.protocol === 'https';
}

export function resolveOAuthRedirectUri(req) {
  const publicOrigin = configuredPublicOrigin();
  const redirectUri = configuredOAuthRedirectUri();
  if (publicOrigin && redirectUri && publicOrigin !== new URL(redirectUri).origin) {
    throw new PublicOriginConfigurationError(
      'PUNCHPILOT_PUBLIC_ORIGIN and OAUTH_REDIRECT_URI must use the same origin',
    );
  }
  if (redirectUri) return redirectUri;
  if (publicOrigin) return `${publicOrigin}${OAUTH_CALLBACK_PATH}`;

  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin && isLoopbackHostname(new URL(requestOrigin).hostname)) {
    return `${requestOrigin}${OAUTH_CALLBACK_PATH}`;
  }
  throw new PublicOriginConfigurationError(
    'A canonical public origin is required outside loopback',
  );
}
