import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TokenService } from '../../modules/auth/services/token.service';
import { AppError } from '../errors/app-error';

@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
  constructor(private readonly tokens: TokenService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header) {
      next();
      return;
    }

    const [scheme, token, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      req.authError = 'invalid_token';
      next();
      return;
    }

    try {
      req.principal = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      req.authError =
        error instanceof AppError && error.code === 'TOKEN_EXPIRED'
          ? 'expired_token'
          : 'invalid_token';
    }

    next();
  }
}
