import { afterEach, describe, expect, it } from 'vitest';
import {
  getRequestOrigin,
  normalizeOriginHeader,
  requestUsesSecureTransport,
  resolveOAuthRedirectUri,
  resolvePublicOrigin,
} from '../server/public-origin.js';

const originalPublicOrigin = process.env.PUNCHPILOT_PUBLIC_ORIGIN;
const originalRedirectUri = process.env.OAUTH_REDIRECT_URI;

function requestFor(protocol, host) {
  return {
    protocol,
    get(name) {
      return name === 'host' ? host : undefined;
    },
  };
}

afterEach(() => {
  if (originalPublicOrigin === undefined) delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
  else process.env.PUNCHPILOT_PUBLIC_ORIGIN = originalPublicOrigin;
  if (originalRedirectUri === undefined) delete process.env.OAUTH_REDIRECT_URI;
  else process.env.OAUTH_REDIRECT_URI = originalRedirectUri;
});

describe('canonical public origin', () => {
  it('does not derive an external public origin or OAuth redirect from Host', () => {
    delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    delete process.env.OAUTH_REDIRECT_URI;
    const req = requestFor('https', 'host-injection.example.invalid');

    expect(getRequestOrigin(req)).toBe('https://host-injection.example.invalid');
    expect(resolvePublicOrigin(req)).toBeNull();
    expect(() => resolveOAuthRedirectUri(req)).toThrowError(
      expect.objectContaining({ code: 'PUBLIC_ORIGIN_CONFIGURATION_INVALID' }),
    );
  });

  it('derives both browser and OAuth origins from the canonical HTTPS setting', () => {
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    delete process.env.OAUTH_REDIRECT_URI;
    const req = requestFor('https', 'host-injection.example.invalid');

    expect(resolvePublicOrigin(req)).toBe('https://punchpilot.example.invalid');
    expect(resolveOAuthRedirectUri(req)).toBe(
      'https://punchpilot.example.invalid/api/config/oauth-callback',
    );
    expect(requestUsesSecureTransport(requestFor('http', 'backend.invalid'))).toBe(true);
  });

  it('permits zero-configuration loopback operation', () => {
    delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    delete process.env.OAUTH_REDIRECT_URI;
    const req = requestFor('http', '127.0.0.1:8681');

    expect(resolvePublicOrigin(req)).toBe('http://127.0.0.1:8681');
    expect(resolveOAuthRedirectUri(req)).toBe(
      'http://127.0.0.1:8681/api/config/oauth-callback',
    );
    expect(requestUsesSecureTransport(req)).toBe(false);
  });

  it('uses the verified request protocol only when no canonical origin is configured', () => {
    delete process.env.PUNCHPILOT_PUBLIC_ORIGIN;
    delete process.env.OAUTH_REDIRECT_URI;

    expect(requestUsesSecureTransport(requestFor('https', 'external.example.invalid')))
      .toBe(true);
    expect(requestUsesSecureTransport(requestFor('http', 'external.example.invalid')))
      .toBe(false);
  });

  it('rejects insecure external origins and conflicting OAuth origins', () => {
    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'http://punchpilot.example.invalid';
    expect(() => resolvePublicOrigin(requestFor('http', 'punchpilot.example.invalid')))
      .toThrowError(expect.objectContaining({ code: 'PUBLIC_ORIGIN_CONFIGURATION_INVALID' }));

    process.env.PUNCHPILOT_PUBLIC_ORIGIN = 'https://punchpilot.example.invalid';
    process.env.OAUTH_REDIRECT_URI =
      'https://other.example.invalid/api/config/oauth-callback';
    expect(() => resolveOAuthRedirectUri(requestFor('https', 'punchpilot.example.invalid')))
      .toThrowError(expect.objectContaining({ code: 'PUBLIC_ORIGIN_CONFIGURATION_INVALID' }));
  });

  it('accepts only origin-shaped browser Origin headers', () => {
    expect(normalizeOriginHeader('https://punchpilot.example.invalid')).toBe(
      'https://punchpilot.example.invalid',
    );
    expect(normalizeOriginHeader('https://punchpilot.example.invalid/path')).toBeNull();
    expect(normalizeOriginHeader('https://user@punchpilot.example.invalid')).toBeNull();
    expect(normalizeOriginHeader('null')).toBeNull();
  });
});
