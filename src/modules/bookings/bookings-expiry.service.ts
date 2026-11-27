import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import { AppLogger } from '../../common/logging/app-logger.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BOOKINGS_EXPIRY_INTERVAL_MS } from './booking.constants';

/**
 * Q7 hold expiry. Runs every 60 seconds without a new dependency. The job is
 * idempotent: it only moves `pending_payment` rows whose `expires_at <= now()`
 * to `expired`, and never touches confirmed or checked-in bookings.
 *
 * Availability also filters expired holds by time, so a slot is visible as
 * free immediately at `expires_at`; this job releases the database exclusion
 * constraint shortly after (<= 60 s).
 */
@Injectable()
export class BookingsExpiryService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.expireHolds().catch((error: unknown) => {
        this.logger.error(error, 'BookingsExpiryService');
      });
    }, BOOKINGS_EXPIRY_INTERVAL_MS);

    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Expires every hold past its deadline and returns the number of rows moved.
   * Public so the e2e suite can invoke the same routine the timer runs.
   */
  async expireHolds(now: Date = new Date()): Promise<number> {
    const candidates = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.pending_payment,
        expiresAt: { lte: now },
      },
      select: { id: true, establishmentId: true, spaceId: true },
    });

    if (candidates.length === 0) return 0;

    const result = await this.prisma.booking.updateMany({
      where: {
        id: { in: candidates.map((candidate) => candidate.id) },
        status: BookingStatus.pending_payment,
        expiresAt: { lte: now },
      },
      data: { status: BookingStatus.expired },
    });

    for (const candidate of candidates) {
      // Q10 audit: actor is the system, no PII.
      this.logger.raw.info(
        {
          event: 'booking.expired',
          actorId: 'system',
          bookingId: candidate.id,
          establishmentId: candidate.establishmentId,
          spaceId: candidate.spaceId,
          decision: 'allow',
        },
        'booking.expired',
      );
    }

    return result.count;
  }
}
