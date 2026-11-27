import { Injectable } from '@nestjs/common';
import { AuthEventType, Prisma } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { AppLogger } from '../../../common/logging/app-logger.service';
import { hashIdentifier } from '../../../common/utils/crypto.util';
import { PrismaService } from '../../../prisma/prisma.service';

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;

export interface RecordAuthEventInput {
  type: AuthEventType;
  userId?: string;
  identifier?: string;
  requestId?: string;
  ipHash?: string;
  userAgent?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

@Injectable()
export class AuthEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {}

  async record(input: RecordAuthEventInput): Promise<void> {
    try {
      await this.prisma.authEvent.create({
        data: {
          type: input.type,
          userId: input.userId,
          identifierHash: input.identifier
            ? hashIdentifier(input.identifier, this.config.env.PII_HASH_SECRET)
            : undefined,
          ipHash: input.ipHash,
          userAgent: input.userAgent?.slice(0, 512),
          metadata: input.metadata,
        },
      });
    } catch (error) {
      // Un fallo de auditoría no debe tumbar el flujo de autenticación.
      this.logger.raw.error(
        {
          event: 'auth_event_write_failed',
          requestId: input.requestId,
          authEventType: input.type,
          err: error,
        },
        'auth_event_write_failed',
      );
    }
  }

  async getLockout(identifier: string): Promise<LockoutStatus> {
    const identifierHash = hashIdentifier(
      identifier,
      this.config.env.PII_HASH_SECRET,
    );
    const now = new Date();

    const lastSuccess = await this.prisma.authEvent.findFirst({
      where: {
        identifierHash,
        type: AuthEventType.login_succeeded,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    const since = new Date(
      Math.max(
        now.getTime() - LOCKOUT_WINDOW_MS,
        lastSuccess?.createdAt.getTime() ?? 0,
      ),
    );

    const recentFailures = await this.prisma.authEvent.findMany({
      where: {
        identifierHash,
        type: AuthEventType.login_failed,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: LOCKOUT_THRESHOLD,
      select: { createdAt: true },
    });

    if (recentFailures.length < LOCKOUT_THRESHOLD) {
      return { locked: false, retryAfterSeconds: 0 };
    }

    const fifthMostRecent = recentFailures[LOCKOUT_THRESHOLD - 1];
    const unlockAt = new Date(
      fifthMostRecent.createdAt.getTime() + LOCKOUT_WINDOW_MS,
    );

    return {
      locked: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((unlockAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }
}
