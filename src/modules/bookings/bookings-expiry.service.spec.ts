import { BookingStatus } from '@prisma/client';
import type { AppLogger } from '../../common/logging/app-logger.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { BookingsExpiryService } from './bookings-expiry.service';

describe('BookingsExpiryService', () => {
  const now = new Date('2026-06-15T15:00:00.000Z');

  function buildService() {
    const prisma = {
      booking: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const logger = {
      raw: { info: jest.fn() },
      error: jest.fn(),
    };

    const service = new BookingsExpiryService(
      prisma as unknown as PrismaService,
      logger as unknown as AppLogger,
    );

    return { service, prisma, logger };
  }

  it('expires only pending_payment holds with expires_at <= now', async () => {
    const { service, prisma, logger } = buildService();
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 'booking-1',
        establishmentId: 'est-1',
        spaceId: 'space-1',
      },
    ]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.expireHolds(now)).resolves.toBe(1);

    expect(prisma.booking.findMany).toHaveBeenCalledWith({
      where: {
        status: BookingStatus.pending_payment,
        expiresAt: { lte: now },
      },
      select: { id: true, establishmentId: true, spaceId: true },
    });
    expect(prisma.booking.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['booking-1'] },
        status: BookingStatus.pending_payment,
        expiresAt: { lte: now },
      },
      data: { status: BookingStatus.expired },
    });
    expect(logger.raw.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'booking.expired',
        actorId: 'system',
        bookingId: 'booking-1',
        establishmentId: 'est-1',
        decision: 'allow',
      }),
      'booking.expired',
    );
  });

  it('is a no-op when there are no expired holds (confirmed bookings untouched)', async () => {
    const { service, prisma } = buildService();
    prisma.booking.findMany.mockResolvedValue([]);

    await expect(service.expireHolds(now)).resolves.toBe(0);

    expect(prisma.booking.updateMany).not.toHaveBeenCalled();
  });

  it('a second execution is idempotent', async () => {
    const { service, prisma } = buildService();
    prisma.booking.findMany
      .mockResolvedValueOnce([
        { id: 'booking-1', establishmentId: 'est-1', spaceId: 'space-1' },
      ])
      .mockResolvedValueOnce([]);
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.expireHolds(now)).resolves.toBe(1);
    await expect(service.expireHolds(now)).resolves.toBe(0);

    expect(prisma.booking.updateMany).toHaveBeenCalledTimes(1);
  });
});
