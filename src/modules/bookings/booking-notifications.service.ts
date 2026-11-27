import { Injectable } from '@nestjs/common';
import { AppLogger } from '../../common/logging/app-logger.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BookingEmailDetails,
  MailerService,
} from '../auth/services/mailer.service';

export type BookingNotificationEvent = 'created' | 'cancelled';

const bookingNotificationSelect = {
  publicCode: true,
  startsAt: true,
  totalMinor: true,
  currency: true,
  player: { select: { email: true } },
  space: { select: { name: true } },
  establishment: { select: { name: true, timezone: true } },
} as const;

/**
 * Sends transactional booking emails after the booking transaction commits.
 * A delivery failure is logged as `booking_notification_failed` and never
 * propagates: the booking is already persisted and must stay valid.
 */
@Injectable()
export class BookingNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly logger: AppLogger,
  ) {}

  async notifyCreated(bookingId: string): Promise<void> {
    await this.notify(bookingId, 'created');
  }

  async notifyCancelled(bookingId: string): Promise<void> {
    await this.notify(bookingId, 'cancelled');
  }

  private async notify(
    bookingId: string,
    event: BookingNotificationEvent,
  ): Promise<void> {
    try {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: bookingNotificationSelect,
      });

      if (!booking) {
        this.logFailure(bookingId, event, 'BookingNotFound');
        return;
      }

      const details = toBookingEmailDetails(booking);

      if (event === 'created') {
        await this.mailer.sendBookingCreatedEmail(
          booking.player.email,
          details,
        );
        return;
      }

      await this.mailer.sendBookingCancelledEmail(
        booking.player.email,
        details,
      );
    } catch (error) {
      this.logFailure(
        bookingId,
        event,
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }

  /** Logs identifiers and the error class only; never recipient or content. */
  private logFailure(
    bookingId: string,
    event: BookingNotificationEvent,
    errorName: string,
  ): void {
    this.logger.raw.error(
      {
        event: 'booking_notification_failed',
        bookingId,
        notification: event,
        errorName,
      },
      'booking_notification_failed',
    );
  }
}

function toBookingEmailDetails(booking: {
  publicCode: string;
  startsAt: Date;
  totalMinor: bigint;
  currency: string;
  player: { email: string };
  space: { name: string };
  establishment: { name: string; timezone: string };
}): BookingEmailDetails {
  return {
    publicCode: booking.publicCode,
    establishmentName: booking.establishment.name,
    spaceName: booking.space.name,
    startsAt: formatBookingDateTime(
      booking.startsAt,
      booking.establishment.timezone,
    ),
    amount: formatBookingAmount(booking.totalMinor, booking.currency),
    // The current establishment model has no address or cancellation-policy
    // columns; the mailer omits both rows until those fields exist.
    address: null,
    cancellationPolicy: null,
  };
}

export function formatBookingDateTime(
  startsAt: Date,
  timezone: string,
): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(startsAt);
}

export function formatBookingAmount(
  totalMinor: bigint,
  currency: string,
): string {
  const fractionDigits =
    new Intl.NumberFormat('es-CO', { style: 'currency', currency })
      .resolvedOptions()
      .maximumFractionDigits ?? 2;

  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Number(totalMinor) / 10 ** fractionDigits);
}
