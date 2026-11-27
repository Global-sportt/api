import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { safeEqual } from '../utils/crypto.util';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../../modules/auth/auth.constants';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  private readonly allowedOrigins: Set<string>;
  private readonly csrfExemptPaths: Set<string>;

  constructor(private readonly config: AppConfigService) {
    const apiOrigin = new URL(config.env.API_PUBLIC_URL).origin;
    this.allowedOrigins = new Set(
      [...config.corsOrigins, apiOrigin].map((origin) => origin.toLowerCase()),
    );

    const prefix = `/${config.env.API_PREFIX.replace(/^\/+|\/+$/g, '')}`;
    this.csrfExemptPaths = new Set([
      `${prefix}/auth/login`,
      `${prefix}/auth/register`,
      `${prefix}/auth/password/forgot`,
      `${prefix}/auth/password/reset`,
      `${prefix}/auth/verify-email`,
    ]);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      const normalized = origin.replace(/\/$/, '').toLowerCase();
      if (!this.allowedOrigins.has(normalized)) {
        this.reject(
          req,
          res,
          403,
          'CSRF_ORIGIN_REJECTED',
          'El origen de la petición no está permitido.',
        );
        return;
      }
    }

    const refreshCookie = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (refreshCookie && !this.isCsrfExempt(req)) {
      const csrfCookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
      const rawHeader = req.headers['x-csrf-token'];
      const csrfHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

      if (
        !csrfCookie ||
        !csrfHeader ||
        !safeEqual(csrfCookie, csrfHeader)
      ) {
        this.reject(
          req,
          res,
          403,
          'CSRF_TOKEN_INVALID',
          'Falta el token CSRF o no coincide.',
        );
        return;
      }
    }

    next();
  }

  private isCsrfExempt(req: Request): boolean {
    const path = req.path.replace(/\/+$/, '') || '/';
    if (this.csrfExemptPaths.has(path)) return true;

    // Los clientes móviles/API envían el refresh token en el body, no en cookie.
    if (path.endsWith('/auth/refresh') || path.endsWith('/auth/logout')) {
      const body = req.body as Record<string, unknown> | undefined;
      return (
        typeof body?.refreshToken === 'string' ||
        typeof body?.refresh_token === 'string'
      );
    }

    return false;
  }

  private reject(
    req: Request,
    res: Response,
    status: number,
    code: string,
    message: string,
  ): void {
    res
      .status(status)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: 'Forbidden',
        status,
        code,
        message,
        trace_id: req.id,
        timestamp: new Date().toISOString(),
        path: req.path,
      });
  }
}
