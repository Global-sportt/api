import type { Request, Response } from 'express';
import type { AppConfigService } from '../../../config/app-config.service';
import {
  CSRF_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  REFRESH_COOKIE,
} from '../auth.constants';
import { AuthCookiesService } from './auth-cookies.service';

function buildService(
  overrides: Partial<{
    apiPrefix: string;
    cookieSecure: boolean;
    cookieSameSite: 'lax' | 'strict' | 'none';
    cookieDomain: string;
  }> = {},
) {
  const config = {
    env: {
      API_PREFIX: overrides.apiPrefix ?? '/api/v1/',
      COOKIE_DOMAIN: overrides.cookieDomain ?? '',
    },
    cookieSecure: overrides.cookieSecure ?? true,
    cookieSameSite: overrides.cookieSameSite ?? 'strict',
  } as unknown as AppConfigService;

  const response = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
  const request = (cookies: Record<string, unknown>) =>
    ({ cookies }) as unknown as Request;

  return {
    service: new AuthCookiesService(config),
    response,
    request,
  };
}

describe('AuthCookiesService', () => {
  it('sets an httpOnly refresh cookie scoped to /auth and a readable CSRF cookie', () => {
    const { service, response } = buildService();
    const expiresAt = new Date('2026-12-31T00:00:00.000Z');

    service.setSessionCookies(response as unknown as Response, {
      refreshToken: 'refresh-token',
      refreshExpiresAt: expiresAt,
      csrfToken: 'csrf-token',
    });

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      REFRESH_COOKIE,
      'refresh-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/api/v1/auth',
        expires: expiresAt,
      }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      CSRF_COOKIE,
      'csrf-token',
      expect.objectContaining({
        httpOnly: false,
        secure: true,
        sameSite: 'strict',
        path: '/',
        expires: expiresAt,
      }),
    );
  });

  it('binds the OAuth state cookie to the OAuth path with SameSite=Lax', () => {
    const { service, response } = buildService({
      cookieDomain: 'auth.example.test',
    });

    service.setOAuthStateCookie(
      response as unknown as Response,
      'state-hash',
    );

    expect(response.cookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      'state-hash',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/api/v1/auth/oauth/google',
        maxAge: OAUTH_STATE_TTL_MS,
        domain: 'auth.example.test',
      },
    );
  });

  it('reads only non-empty string cookies', () => {
    const { service, request } = buildService();

    expect(
      service.getRefreshToken(request({ [REFRESH_COOKIE]: 'token' })),
    ).toBe('token');
    expect(
      service.getCsrfToken(request({ [CSRF_COOKIE]: 'csrf' })),
    ).toBe('csrf');
    expect(
      service.getOAuthStateCookie(request({ [OAUTH_STATE_COOKIE]: 'hash' })),
    ).toBe('hash');

    for (const invalid of ['', 123, null, undefined, { value: 'x' }]) {
      const req = request({
        [REFRESH_COOKIE]: invalid,
        [CSRF_COOKIE]: invalid,
        [OAUTH_STATE_COOKIE]: invalid,
      });
      expect(service.getRefreshToken(req)).toBeUndefined();
      expect(service.getCsrfToken(req)).toBeUndefined();
      expect(service.getOAuthStateCookie(req)).toBeUndefined();
    }
  });

  it('reuses an existing CSRF token and issues a new one when absent', () => {
    const { service, request } = buildService();

    expect(service.issueCsrfToken(request({ [CSRF_COOKIE]: 'existing' }))).toBe(
      'existing',
    );

    const issued = service.issueCsrfToken(request({}));
    expect(typeof issued).toBe('string');
    expect(issued.length).toBeGreaterThanOrEqual(32);
  });

  it('clears refresh, CSRF and OAuth state cookies with their original paths', () => {
    const { service, response } = buildService({
      cookieSecure: false,
      cookieSameSite: 'lax',
    });

    service.clearSessionCookies(response as unknown as Response);
    service.clearOAuthStateCookie(response as unknown as Response);

    expect(response.clearCookie).toHaveBeenNthCalledWith(
      1,
      REFRESH_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        path: '/api/v1/auth',
        secure: false,
        sameSite: 'lax',
      }),
    );
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      2,
      CSRF_COOKIE,
      expect.objectContaining({ httpOnly: false, path: '/' }),
    );
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      3,
      OAUTH_STATE_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        path: '/api/v1/auth/oauth/google',
        sameSite: 'lax',
      }),
    );
  });
});
