import { Injectable } from '@nestjs/common';
import { AuthEventType, UserStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import type { RequestMetadata } from '../../../common/http/request-metadata';
import { AppError } from '../../../common/errors/app-error';
import {
  randomToken,
  sha256,
} from '../../../common/utils/crypto.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { REFRESH_TOKEN_PREFIX } from '../auth.constants';
import { AuthEventsService } from './auth-events.service';
import { TokenService } from './token.service';
import {
  UsersService,
  userWithProfile,
  type PublicUser,
  type UserWithProfile,
} from '../../users/users.service';

const REFRESH_TOKEN_PATTERN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{20,200})$/i;

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresIn: number;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: PublicUser;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    private readonly events: AuthEventsService,
  ) {}

  async createSession(
    user: UserWithProfile,
    meta: RequestMetadata,
  ): Promise<IssuedSession> {
    const sessionId = randomUUID();
    const now = Date.now();
    const absoluteExpiresAt = new Date(
      now + this.config.sessionAbsoluteTtlMs,
    );
    const refreshExpiresAt = new Date(
      Math.min(now + this.config.refreshTokenTtlMs, absoluteExpiresAt.getTime()),
    );
    const initial = this.newRefreshToken(sessionId);

    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          expiresAt: refreshExpiresAt,
          absoluteExpiresAt,
          ipHash: meta.ipHash,
          userAgent: meta.userAgent,
        },
      }),
      this.prisma.refreshToken.create({
        data: {
          sessionId,
          tokenHash: initial.hash,
          expiresAt: refreshExpiresAt,
        },
      }),
    ]);

    const access = await this.tokens.signAccessToken({
      userId: user.id,
      sessionId,
    });

    return {
      sessionId,
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: initial.raw,
      refreshTokenExpiresAt: refreshExpiresAt,
      user: this.users.toPublicUser(user),
    };
  }

  async refresh(
    rawRefreshToken: string,
    meta: RequestMetadata,
  ): Promise<IssuedSession> {
    const parsed = this.parseRefreshToken(rawRefreshToken);
    if (!parsed) {
      throw this.invalidRefreshToken();
    }

    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: { include: userWithProfile } },
    });

    const now = new Date();
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'La sesión expiró. Inicia sesión de nuevo.',
      );
    }

    if (session.user.status !== UserStatus.active) {
      await this.revokeSession(session.id, 'user_not_active');
      throw new AppError(
        403,
        'ACCOUNT_SUSPENDED',
        'La cuenta no está activa. Contacta a soporte.',
      );
    }

    const tokenHash = sha256(parsed.secret);
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });

    if (!token || token.sessionId !== session.id) {
      throw this.invalidRefreshToken();
    }

    if (token.usedAt !== null || token.revokedAt !== null) {
      await this.handleReuse(session.id, session.userId, meta);
      throw this.invalidRefreshToken();
    }

    if (token.expiresAt <= now) {
      await this.revokeSession(session.id, 'refresh_token_expired');
      throw new AppError(
        401,
        'REFRESH_TOKEN_EXPIRED',
        'La sesión expiró. Inicia sesión de nuevo.',
      );
    }

    const nextExpiresAt = new Date(
      Math.min(
        now.getTime() + this.config.refreshTokenTtlMs,
        session.absoluteExpiresAt.getTime(),
      ),
    );
    if (nextExpiresAt <= now) {
      await this.revokeSession(session.id, 'absolute_expiration');
      throw new AppError(
        401,
        'SESSION_EXPIRED',
        'La sesión expiró. Inicia sesión de nuevo.',
      );
    }

    const rotated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: {
          id: token.id,
          usedAt: null,
          revokedAt: null,
        },
        data: { usedAt: now, revokedAt: now },
      });

      if (claimed.count !== 1) return null;

      const replacement = this.newRefreshToken(session.id);
      const replacementId = randomUUID();

      await tx.refreshToken.create({
        data: {
          id: replacementId,
          sessionId: session.id,
          tokenHash: replacement.hash,
          expiresAt: nextExpiresAt,
        },
      });
      await tx.refreshToken.update({
        where: { id: token.id },
        data: { replacedByTokenId: replacementId },
      });
      await tx.session.update({
        where: { id: session.id },
        data: { lastUsedAt: now, expiresAt: nextExpiresAt },
      });

      return replacement;
    });

    if (!rotated) {
      await this.handleReuse(session.id, session.userId, meta);
      throw this.invalidRefreshToken();
    }

    const access = await this.tokens.signAccessToken({
      userId: session.userId,
      sessionId: session.id,
    });

    await this.events.record({
      type: AuthEventType.refresh_succeeded,
      userId: session.userId,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });

    return {
      sessionId: session.id,
      accessToken: access.token,
      accessTokenExpiresIn: access.expiresIn,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: rotated.raw,
      refreshTokenExpiresAt: nextExpiresAt,
      user: this.users.toPublicUser(session.user),
    };
  }

  async revokeByRawToken(
    rawRefreshToken: string,
    meta: RequestMetadata,
  ): Promise<boolean> {
    const parsed = this.parseRefreshToken(rawRefreshToken);
    if (!parsed) return false;

    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(parsed.secret) },
      include: { session: true },
    });
    if (!token || token.sessionId !== parsed.sessionId) return false;

    await this.revokeSession(token.sessionId, 'logout');
    await this.events.record({
      type: AuthEventType.logout,
      userId: token.session.userId,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
    });
    return true;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  async revokeAllForUser(
    userId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true },
    });
    if (sessions.length === 0) return 0;

    const sessionIds = sessions.map((session) => session.id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { id: { in: sessionIds } },
        data: { revokedAt: now, revokedReason: 'logout_all' },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId: { in: sessionIds }, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    return sessionIds.length;
  }

  private async handleReuse(
    sessionId: string,
    userId: string,
    meta: RequestMetadata,
  ): Promise<never> {
    await this.revokeSession(sessionId, 'refresh_token_reuse');
    await this.events.record({
      type: AuthEventType.refresh_reuse_detected,
      userId,
      requestId: meta.requestId,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent,
      metadata: { sessionId },
    });
    throw new AppError(
      401,
      'REFRESH_TOKEN_REUSED',
      'La sesión se revocó por seguridad. Inicia sesión de nuevo.',
    );
  }

  private newRefreshToken(sessionId: string): {
    raw: string;
    hash: string;
  } {
    const secret = randomToken(32);
    return {
      raw: `${REFRESH_TOKEN_PREFIX}.${sessionId}.${secret}`,
      hash: sha256(secret),
    };
  }

  private parseRefreshToken(
    raw: string,
  ): { sessionId: string; secret: string } | null {
    const match = REFRESH_TOKEN_PATTERN.exec(raw);
    if (!match) return null;
    return { sessionId: match[1], secret: match[2] };
  }

  private invalidRefreshToken(): AppError {
    return new AppError(
      401,
      'REFRESH_TOKEN_INVALID',
      'El refresh token no es válido.',
    );
  }
}
