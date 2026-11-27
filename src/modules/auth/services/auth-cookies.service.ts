import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfigService } from '../../../config/app-config.service';
import { randomToken } from '../../../common/utils/crypto.util';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../auth.constants';

export interface SessionCookieInput {
  refreshToken: string;
  refreshExpiresAt: Date;
  csrfToken: string;
}

@Injectable()
export class AuthCookiesService {
  private readonly refreshPath: string;
  private readonly domain?: string;

  constructor(private readonly config: AppConfigService) {
    const prefix = config.env.API_PREFIX.replace(/^\/+|\/+$/g, '');
    this.refreshPath = `/${prefix}/auth`;
    this.domain = config.env.COOKIE_DOMAIN || undefined;
  }

  setSessionCookies(res: Response, input: SessionCookieInput): void {
    res.cookie(REFRESH_COOKIE, input.refreshToken, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: this.config.cookieSameSite,
      path: this.refreshPath,
      expires: input.refreshExpiresAt,
      domain: this.domain,
    });

    this.setCsrfCookie(res, input.csrfToken, input.refreshExpiresAt);
  }

  setCsrfCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: this.config.cookieSecure,
      sameSite: this.config.cookieSameSite,
      path: '/',
      expires: expiresAt,
      domain: this.domain,
    });
  }

  clearSessionCookies(res: Response): void {
    const base = {
      secure: this.config.cookieSecure,
      sameSite: this.config.cookieSameSite,
      domain: this.domain,
    };

    res.clearCookie(REFRESH_COOKIE, {
      ...base,
      httpOnly: true,
      path: this.refreshPath,
    });
    res.clearCookie(CSRF_COOKIE, {
      ...base,
      httpOnly: false,
      path: '/',
    });
  }

  getRefreshToken(req: Request): string | undefined {
    const value = req.cookies?.[REFRESH_COOKIE] as unknown;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  getCsrfToken(req: Request): string | undefined {
    const value = req.cookies?.[CSRF_COOKIE] as unknown;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  issueCsrfToken(req: Request): string {
    return this.getCsrfToken(req) ?? randomToken(32);
  }
}
