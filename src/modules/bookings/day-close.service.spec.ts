import { BookingStatus } from '@prisma/client';

jest.mock('@cerbos/core', () => ({
  PlanKind: {
    ALWAYS_ALLOWED: 'KIND_ALWAYS_ALLOWED',
    ALWAYS_DENIED: 'KIND_ALWAYS_DENIED',
    CONDITIONAL: 'KIND_CONDITIONAL',
  },
}));

import { AppError } from '../../common/errors/app-error';
import type { AppLogger } from '../../common/logging/app-logger.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  DAY_CLOSE_MAX_RANGE_DAYS,
  DayCloseService,
  assertDayNotClosed,
  formatLocalDate,
  summarizeDayBookings,
} from './day-close.service';

const ESTABLISHMENT_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const DATE = '2026-11-20';
const DATE_UTC = new Date('2026-11-20T00:00:00.000Z');
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPACE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface DayCloseRow {
  id: string;
  establishmentId: string;
  date: Date;
  closedAt: Date;
  closedByUserId: string;
  reopenedAt: Date | null;
  reopenedByUserId: string | null;
  bookingsCount: number;
  noShowCount: number;
  cancelledCount: number;
  totalMinor: bigint;
  currency: string;
  spaceTotals: Array<{
    id: string;
    dayCloseId: string;
    spaceId: string;
    bookingsCount: number;
    noShowCount: number;
    totalMinor: bigint;
  }>;
}

function dayCloseRow(overrides: Partial<DayCloseRow> = {}): DayCloseRow {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    establishmentId: ESTABLISHMENT_ID,
    date: DATE_UTC,
    closedAt: new Date('2026-11-21T03:00:00.000Z'),
    closedByUserId: ACTOR_ID,
    reopenedAt: null,
    reopenedByUserId: null,
    bookingsCount: 3,
    noShowCount: 1,
    cancelledCount: 1,
    totalMinor: 90_000n,
    currency: 'COP',
    spaceTotals: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        dayCloseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        spaceId: SPACE_A,
        bookingsCount: 2,
        noShowCount: 1,
        totalMinor: 50_000n,
      },
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        dayCloseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        spaceId: SPACE_B,
        bookingsCount: 1,
        noShowCount: 0,
        totalMinor: 40_000n,
      },
    ],
    ...overrides,
  };
}

interface PrismaMock {
  establishment: { findUnique: jest.Mock };
  booking: { findMany: jest.Mock };
  dayClose: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  $transaction: jest.Mock;
}

interface TxMock {
  dayClose: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  dayCloseSpaceTotal: { deleteMany: jest.Mock };
}

function buildService(): {
  service: DayCloseService;
  prisma: PrismaMock;
  tx: TxMock;
  logger: { raw: { info: jest.Mock } };
} {
  const tx: TxMock = {
    dayClose: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    dayCloseSpaceTotal: { deleteMany: jest.fn() },
  };

  const prisma: PrismaMock = {
    establishment: { findUnique: jest.fn() },
    booking: { findMany: jest.fn() },
    dayClose: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    $transaction: jest.fn(async (callback: (client: TxMock) => unknown) =>
      callback(tx),
    ),
  };

  const logger = { raw: { info: jest.fn() } };

  return {
    service: new DayCloseService(
      prisma as unknown as PrismaService,
      logger as unknown as AppLogger,
    ),
    prisma,
    tx,
    logger,
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Se esperaba AppError ${status} ${code}`);
}

describe('summarizeDayBookings', () => {
  it('totaliza por espacio e incluye no-show en conteo y total', () => {
    const snapshot = summarizeDayBookings([
      { spaceId: SPACE_A, status: BookingStatus.confirmed, totalMinor: 25_000n },
      { spaceId: SPACE_A, status: BookingStatus.no_show, totalMinor: 25_000n },
      { spaceId: SPACE_B, status: BookingStatus.completed, totalMinor: 40_000n },
      { spaceId: SPACE_B, status: BookingStatus.checked_in, totalMinor: 10_000n },
    ]);

    expect(snapshot).toEqual({
      bookingsCount: 4,
      noShowCount: 1,
      cancelledCount: 0,
      totalMinor: 100_000n,
      spaces: [
        {
          spaceId: SPACE_A,
          bookingsCount: 2,
          noShowCount: 1,
          totalMinor: 50_000n,
        },
        {
          spaceId: SPACE_B,
          bookingsCount: 2,
          noShowCount: 0,
          totalMinor: 50_000n,
        },
      ],
    });
  });

  it('excluye canceladas, expiradas y pending_payment del total y del conteo', () => {
    const snapshot = summarizeDayBookings([
      { spaceId: SPACE_A, status: BookingStatus.confirmed, totalMinor: 25_000n },
      { spaceId: SPACE_A, status: BookingStatus.cancelled, totalMinor: 25_000n },
      { spaceId: SPACE_B, status: BookingStatus.expired, totalMinor: 25_000n },
      {
        spaceId: SPACE_C,
        status: BookingStatus.pending_payment,
        totalMinor: 25_000n,
      },
    ]);

    expect(snapshot.bookingsCount).toBe(1);
    expect(snapshot.noShowCount).toBe(0);
    expect(snapshot.cancelledCount).toBe(1);
    expect(snapshot.totalMinor).toBe(25_000n);
    expect(snapshot.spaces).toHaveLength(1);
    expect(snapshot.spaces[0]?.spaceId).toBe(SPACE_A);
  });

  it('no inventa espacios sin reservas computables', () => {
    const snapshot = summarizeDayBookings([
      { spaceId: SPACE_A, status: BookingStatus.cancelled, totalMinor: 10_000n },
    ]);

    expect(snapshot.spaces).toEqual([]);
    expect(snapshot.totalMinor).toBe(0n);
  });
});

describe('DayCloseService.closeDay', () => {
  function primeClose(
    serviceMocks: ReturnType<typeof buildService>,
  ): ReturnType<typeof buildService> {
    serviceMocks.prisma.establishment.findUnique.mockResolvedValue({
      timezone: 'America/Bogota',
      currency: 'COP',
    });
    serviceMocks.prisma.booking.findMany.mockResolvedValue([
      { spaceId: SPACE_A, status: BookingStatus.confirmed, totalMinor: 25_000n },
      { spaceId: SPACE_A, status: BookingStatus.no_show, totalMinor: 25_000n },
      { spaceId: SPACE_B, status: BookingStatus.completed, totalMinor: 40_000n },
      { spaceId: SPACE_B, status: BookingStatus.cancelled, totalMinor: 40_000n },
      { spaceId: SPACE_C, status: BookingStatus.expired, totalMinor: 40_000n },
    ]);
    return serviceMocks;
  }

  it('crea la foto del día local con totales por espacio y auditoría', async () => {
    const mocks = primeClose(buildService());
    mocks.tx.dayClose.findUnique.mockResolvedValue(null);
    mocks.tx.dayClose.create.mockResolvedValue(dayCloseRow());

    const result = await mocks.service.closeDay(ACTOR_ID, ESTABLISHMENT_ID, DATE);

    expect(result.created).toBe(true);
    expect(result.dayClose).toMatchObject({
      establishmentId: ESTABLISHMENT_ID,
      date: DATE,
      bookingsCount: 3,
      noShowCount: 1,
      cancelledCount: 1,
      totalMinor: '90000',
      currency: 'COP',
      reopenedAt: null,
    });

    // Límites del día local: Bogotá es UTC-5 todo el año.
    expect(mocks.prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          establishmentId: ESTABLISHMENT_ID,
          startsAt: {
            gte: new Date('2026-11-20T05:00:00.000Z'),
            lt: new Date('2026-11-21T05:00:00.000Z'),
          },
        },
      }),
    );

    expect(mocks.tx.dayClose.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          establishmentId: ESTABLISHMENT_ID,
          date: DATE_UTC,
          closedByUserId: ACTOR_ID,
          bookingsCount: 3,
          noShowCount: 1,
          cancelledCount: 1,
          totalMinor: 90_000n,
          currency: 'COP',
          spaceTotals: {
            create: [
              {
                spaceId: SPACE_A,
                bookingsCount: 2,
                noShowCount: 1,
                totalMinor: 50_000n,
              },
              {
                spaceId: SPACE_B,
                bookingsCount: 1,
                noShowCount: 0,
                totalMinor: 40_000n,
              },
            ],
          },
        }),
      }),
    );

    expect(mocks.logger.raw.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'day.closed',
        actorId: ACTOR_ID,
        establishmentId: ESTABLISHMENT_ID,
        date: DATE,
        bookingsCount: 3,
        noShowCount: 1,
        cancelledCount: 1,
        totalMinor: '90000',
        reclose: false,
      }),
      'day.closed',
    );
  });

  it('rechaza un segundo cierre del mismo día con 409 DAY_ALREADY_CLOSED', async () => {
    const mocks = primeClose(buildService());
    mocks.tx.dayClose.findUnique.mockResolvedValue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      reopenedAt: null,
    });

    await expectAppError(
      mocks.service.closeDay(ACTOR_ID, ESTABLISHMENT_ID, DATE),
      409,
      'DAY_ALREADY_CLOSED',
    );
    expect(mocks.tx.dayClose.create).not.toHaveBeenCalled();
    expect(mocks.tx.dayClose.update).not.toHaveBeenCalled();
  });

  it('recalcula la foto al volver a cerrar un día reabierto', async () => {
    const mocks = primeClose(buildService());
    mocks.tx.dayClose.findUnique.mockResolvedValue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      reopenedAt: new Date('2026-11-21T10:00:00.000Z'),
    });
    mocks.tx.dayClose.update.mockResolvedValue(
      dayCloseRow({
        reopenedAt: null,
        reopenedByUserId: null,
        closedAt: new Date('2026-11-22T03:00:00.000Z'),
        bookingsCount: 3,
        totalMinor: 90_000n,
      }),
    );

    const result = await mocks.service.closeDay(ACTOR_ID, ESTABLISHMENT_ID, DATE);

    expect(result.created).toBe(false);
    expect(mocks.tx.dayCloseSpaceTotal.deleteMany).toHaveBeenCalledWith({
      where: { dayCloseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    });
    expect(mocks.tx.dayClose.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        data: expect.objectContaining({
          reopenedAt: null,
          reopenedByUserId: null,
          closedByUserId: ACTOR_ID,
          bookingsCount: 3,
          cancelledCount: 1,
          totalMinor: 90_000n,
          spaceTotals: {
            create: [
              {
                spaceId: SPACE_A,
                bookingsCount: 2,
                noShowCount: 1,
                totalMinor: 50_000n,
              },
              {
                spaceId: SPACE_B,
                bookingsCount: 1,
                noShowCount: 0,
                totalMinor: 40_000n,
              },
            ],
          },
        }),
      }),
    );
    expect(mocks.logger.raw.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'day.closed', reclose: true }),
      'day.closed',
    );
  });

  it('rechaza fechas que no son YYYY-MM-DD', async () => {
    const mocks = buildService();

    await expectAppError(
      mocks.service.closeDay(ACTOR_ID, ESTABLISHMENT_ID, '2026-02-31'),
      400,
      'VALIDATION_ERROR',
    );
    expect(mocks.prisma.booking.findMany).not.toHaveBeenCalled();
  });
});

describe('DayCloseService.reopen', () => {
  it('marca reopenedAt y reopenedByUserId con auditoría', async () => {
    const mocks = buildService();
    mocks.prisma.dayClose.findUnique.mockResolvedValue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      reopenedAt: null,
      bookingsCount: 3,
      noShowCount: 1,
      cancelledCount: 1,
      totalMinor: 90_000n,
    });
    mocks.prisma.dayClose.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.dayClose.findUniqueOrThrow.mockResolvedValue(
      dayCloseRow({
        reopenedAt: new Date('2026-11-21T12:00:00.000Z'),
        reopenedByUserId: ACTOR_ID,
      }),
    );

    const reopened = await mocks.service.reopen(
      ACTOR_ID,
      ESTABLISHMENT_ID,
      DATE,
    );

    expect(reopened.reopenedAt).toBe('2026-11-21T12:00:00.000Z');
    expect(reopened.reopenedByUserId).toBe(ACTOR_ID);
    expect(mocks.prisma.dayClose.updateMany).toHaveBeenCalledWith({
      where: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', reopenedAt: null },
      data: {
        reopenedAt: expect.any(Date),
        reopenedByUserId: ACTOR_ID,
      },
    });
    expect(mocks.logger.raw.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'day.reopened',
        actorId: ACTOR_ID,
        establishmentId: ESTABLISHMENT_ID,
        date: DATE,
        totalMinor: '90000',
      }),
      'day.reopened',
    );
  });

  it('rechaza reabrir un día ya reabierto con 409', async () => {
    const mocks = buildService();
    mocks.prisma.dayClose.findUnique.mockResolvedValue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      reopenedAt: new Date('2026-11-21T12:00:00.000Z'),
      bookingsCount: 3,
      noShowCount: 1,
      cancelledCount: 1,
      totalMinor: 90_000n,
    });

    await expectAppError(
      mocks.service.reopen(ACTOR_ID, ESTABLISHMENT_ID, DATE),
      409,
      'DAY_ALREADY_REOPENED',
    );
    expect(mocks.prisma.dayClose.updateMany).not.toHaveBeenCalled();
  });

  it('responde 404 si el día nunca se cerró', async () => {
    const mocks = buildService();
    mocks.prisma.dayClose.findUnique.mockResolvedValue(null);

    await expectAppError(
      mocks.service.reopen(ACTOR_ID, ESTABLISHMENT_ID, DATE),
      404,
      'DAY_CLOSE_NOT_FOUND',
    );
  });
});

describe('DayCloseService consultas', () => {
  it('lista el rango y rechaza más de 92 días', async () => {
    const mocks = buildService();
    mocks.prisma.dayClose.findMany.mockResolvedValue([dayCloseRow()]);

    const rows = await mocks.service.list(ESTABLISHMENT_ID, {
      from: DATE,
      to: DATE,
    });
    expect(rows).toHaveLength(1);

    const tooWideFrom = '2026-01-01';
    const tooWideTo = '2026-12-31';
    const span =
      (new Date(`${tooWideTo}T00:00:00.000Z`).getTime() -
        new Date(`${tooWideFrom}T00:00:00.000Z`).getTime()) /
        86_400_000 +
      1;
    expect(span).toBeGreaterThan(DAY_CLOSE_MAX_RANGE_DAYS);

    await expectAppError(
      mocks.service.list(ESTABLISHMENT_ID, {
        from: tooWideFrom,
        to: tooWideTo,
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rechaza un rango invertido', async () => {
    const mocks = buildService();

    await expectAppError(
      mocks.service.list(ESTABLISHMENT_ID, {
        from: '2026-11-21',
        to: '2026-11-20',
      }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('responde 404 si no existe cierre para la fecha', async () => {
    const mocks = buildService();
    mocks.prisma.dayClose.findUnique.mockResolvedValue(null);

    await expectAppError(
      mocks.service.getByDate(ESTABLISHMENT_ID, DATE),
      404,
      'DAY_CLOSE_NOT_FOUND',
    );
  });
});

describe('guard de día cerrado', () => {
  it('bloquea con DAY_CLOSED cuando el cierre está vigente', async () => {
    const prisma = {
      dayClose: { findUnique: jest.fn().mockResolvedValue({ reopenedAt: null }) },
    };

    await expectAppError(
      assertDayNotClosed(
        prisma as unknown as Pick<PrismaService, 'dayClose'>,
        ESTABLISHMENT_ID,
        DATE,
      ),
      409,
      'DAY_CLOSED',
    );
  });

  it('permite operar cuando el día fue reabierto o no tiene cierre', async () => {
    const reopened = {
      dayClose: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ reopenedAt: new Date('2026-11-21T12:00:00Z') }),
      },
    };
    const absent = {
      dayClose: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    await expect(
      assertDayNotClosed(
        reopened as unknown as Pick<PrismaService, 'dayClose'>,
        ESTABLISHMENT_ID,
        DATE,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertDayNotClosed(
        absent as unknown as Pick<PrismaService, 'dayClose'>,
        ESTABLISHMENT_ID,
        DATE,
      ),
    ).resolves.toBeUndefined();
  });

  it('formatLocalDate usa el día de la sede, no UTC', () => {
    expect(
      formatLocalDate(new Date('2026-11-21T03:00:00.000Z'), 'America/Bogota'),
    ).toBe('2026-11-20');
    expect(
      formatLocalDate(new Date('2026-11-21T03:00:00.000Z'), 'UTC'),
    ).toBe('2026-11-21');
  });
});
