import type { AppLogger } from '../../common/logging/app-logger.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailerService } from '../auth/services/mailer.service';
import {
  BookingNotificationsService,
  formatBookingAmount,
  formatBookingDateTime,
} from './booking-notifications.service';

const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const PLAYER_EMAIL = 'jugador@example.com';

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    publicCode: 'BK0123456789ABCDEF0123',
    startsAt: new Date('2026-12-01T14:30:00.000Z'),
    totalMinor: 25_000n,
    currency: 'COP',
    player: { email: PLAYER_EMAIL },
    space: { name: 'Cancha 1' },
    establishment: { name: 'Sede Norte', timezone: 'America/Bogota' },
    ...overrides,
  };
}

function buildService() {
  const prisma = { booking: { findUnique: jest.fn() } };
  const mailer = {
    sendBookingCreatedEmail: jest.fn().mockResolvedValue(undefined),
    sendBookingCancelledEmail: jest.fn().mockResolvedValue(undefined),
  };
  const logger = {
    raw: { info: jest.fn(), error: jest.fn() },
    error: jest.fn(),
  };

  const service = new BookingNotificationsService(
    prisma as unknown as PrismaService,
    mailer as unknown as MailerService,
    logger as unknown as AppLogger,
  );

  return { service, prisma, mailer, logger };
}

describe('BookingNotificationsService', () => {
  describe('formatting', () => {
    it('renders the start in the establishment timezone, not UTC', () => {
      const startsAt = new Date('2026-12-01T14:30:00.000Z');

      expect(formatBookingDateTime(startsAt, 'America/Bogota')).toBe(
        'martes, 1 de diciembre de 2026, 09:30',
      );
      expect(formatBookingDateTime(startsAt, 'UTC')).toBe(
        'martes, 1 de diciembre de 2026, 14:30',
      );
    });

    it('renders the amount using the currency minor units', () => {
      // COP has no minor unit in this locale: the stored 25_000 is $ 25.000.
      expect(formatBookingAmount(25_000n, 'COP')).toBe('$\u00a025.000');
      // USD has two digits: 123_456 minor units are US$ 1.234,56.
      expect(formatBookingAmount(123_456n, 'USD')).toBe('US$\u00a01.234,56');
    });
  });

  describe('notifyCreated', () => {
    it('sends the booking email with the display-ready details', async () => {
      const { service, prisma, mailer } = buildService();
      prisma.booking.findUnique.mockResolvedValue(bookingRow());

      await expect(service.notifyCreated(BOOKING_ID)).resolves.toBeUndefined();

      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        select: expect.objectContaining({
          publicCode: true,
          startsAt: true,
          totalMinor: true,
          currency: true,
        }),
      });
      expect(mailer.sendBookingCreatedEmail).toHaveBeenCalledWith(PLAYER_EMAIL, {
        publicCode: 'BK0123456789ABCDEF0123',
        establishmentName: 'Sede Norte',
        spaceName: 'Cancha 1',
        startsAt: 'martes, 1 de diciembre de 2026, 09:30',
        amount: '$\u00a025.000',
        address: null,
        cancellationPolicy: null,
      });
    });

    it('logs a missing booking and does not send anything', async () => {
      const { service, prisma, mailer, logger } = buildService();
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.notifyCreated(BOOKING_ID)).resolves.toBeUndefined();

      expect(mailer.sendBookingCreatedEmail).not.toHaveBeenCalled();
      expect(logger.raw.error).toHaveBeenCalledWith(
        {
          event: 'booking_notification_failed',
          bookingId: BOOKING_ID,
          notification: 'created',
          errorName: 'BookingNotFound',
        },
        'booking_notification_failed',
      );
    });
  });

  describe('notifyCancelled', () => {
    it('sends the cancellation email to the booking player', async () => {
      const { service, prisma, mailer } = buildService();
      prisma.booking.findUnique.mockResolvedValue(bookingRow());

      await expect(
        service.notifyCancelled(BOOKING_ID),
      ).resolves.toBeUndefined();

      expect(mailer.sendBookingCancelledEmail).toHaveBeenCalledWith(
        PLAYER_EMAIL,
        expect.objectContaining({
          publicCode: 'BK0123456789ABCDEF0123',
          amount: '$\u00a025.000',
        }),
      );
      expect(mailer.sendBookingCreatedEmail).not.toHaveBeenCalled();
    });
  });

  describe('failure isolation', () => {
    it('logs a mailer failure and never propagates it', async () => {
      const { service, prisma, mailer, logger } = buildService();
      prisma.booking.findUnique.mockResolvedValue(bookingRow());
      mailer.sendBookingCancelledEmail.mockRejectedValue(
        new Error('SMTP no disponible'),
      );

      await expect(
        service.notifyCancelled(BOOKING_ID),
      ).resolves.toBeUndefined();

      // Only identifiers and the error class are logged, never the recipient
      // or the rendered content.
      expect(logger.raw.error).toHaveBeenCalledWith(
        {
          event: 'booking_notification_failed',
          bookingId: BOOKING_ID,
          notification: 'cancelled',
          errorName: 'Error',
        },
        'booking_notification_failed',
      );
    });

    it('logs a database failure and never propagates it', async () => {
      const { service, prisma, logger } = buildService();
      prisma.booking.findUnique.mockRejectedValue(
        new Error('connection lost'),
      );

      await expect(service.notifyCreated(BOOKING_ID)).resolves.toBeUndefined();

      expect(logger.raw.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'booking_notification_failed',
          bookingId: BOOKING_ID,
          notification: 'created',
          errorName: 'Error',
        }),
        'booking_notification_failed',
      );
    });
  });
});
