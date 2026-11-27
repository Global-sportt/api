import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { AppConfigService } from '../../../config/app-config.service';
import { isAppRole, type AppRole } from '../../../common/auth/roles';
import { AppError } from '../../../common/errors/app-error';
import type { AuthenticatedPrincipal } from '../../../common/types/express';

interface AccessTokenPayload {
  sub?: string;
  sid?: string;
  role?: string;
  typ?: string;
  jti?: string;
}

export interface SignedAccessToken {
  token: string;
  expiresIn: number;
  expiresAt: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async signAccessToken(input: {
    userId: string;
    sessionId: string;
    role: AppRole;
  }): Promise<SignedAccessToken> {
    const expiresIn = this.config.accessTokenTtlSeconds;
    const token = await this.jwt.signAsync(
      {
        sub: input.userId,
        sid: input.sessionId,
        role: input.role,
        typ: 'access',
      },
      {
        expiresIn,
        jwtid: randomUUID(),
      },
    );

    return {
      token,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedPrincipal> {
    let payload: AccessTokenPayload;

    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: ['HS256'],
      });
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'El token de acceso expiró.');
      }
      if (error instanceof JsonWebTokenError) {
        throw new AppError(401, 'INVALID_TOKEN', 'El token de acceso no es válido.');
      }
      throw new AppError(401, 'INVALID_TOKEN', 'El token de acceso no es válido.');
    }

    if (
      payload.typ !== 'access' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      !isAppRole(payload.role)
    ) {
      throw new AppError(401, 'INVALID_TOKEN', 'El token de acceso no es válido.');
    }

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      role: payload.role,
    };
  }
}
