import { BookingStatus, EstablishmentStatus } from '@prisma/client';
import { AppError } from '../../common/errors/app-error';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  DASHBOARD_CURRENCY,
  DASHBOARD_MAX_PERIOD_DAYS,
  DASHBOARD_TIMEZONE,
  DashboardService,
  resolveDashboardPeriod,
} from './dashboard.service';

/**
 * `2026-06-15T15:00:00Z` is 10:00 in America/Bogota, so the local day is
 * 2026-06-15. The default 30-day window starts on 2026-05-17.
 */
const NOW = new Date('2026-06-15T15:00:00.000Z');

interface PrismaMock {
  establishment: { groupBy: jest.Mock; findMany: jest.Mock };
  user: { groupBy: jest.Mock };
  booking: {
    groupBy: jest.Mock;
    count: jest.Mock;
    aggregate: jest.Mock;
    findMany: jest.Mock;
  };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Se esperaba un AppError ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
  }
}

function recentBookingRow() {
  return {
    id: 'booking-1',
    publicCode: 'BK-1',
    status: BookingStatus.confirmed,
    startsAt: new Date('2026-06-15T15:00:00.000Z'),
    createdAt: new Date('2026-06-14T12:00:00.000Z'),
    totalMinor: 123000n,
    currency: 'COP',
    establishment: { id: 'e1', name: 'Sede Norte' },
    space: { id: 's1', name: 'Cancha 1' },
    player: { id: 'u1', profile: { displayName: 'Ana' } },
  };
}

describe('DashboardService', () => {
  let prisma: PrismaMock;
  let service: DashboardService;

  beforeEach(() => {
    prisma = {
      establishment: { groupBy: jest.fn(), findMany: jest.fn() },
      user: { groupBy: jest.fn() },
      booking: {
        groupBy: jest.fn(),
        count: jest.fn(),
        aggregate: jest.fn(),
        findMany: jest.fn(),
      },
    };

    prisma.establishment.groupBy.mockResolvedValue([
      { status: EstablishmentStatus.active, _count: { _all: 3 } },
      { status: EstablishmentStatus.suspended, _count: { _all: 1 } },
      { status: EstablishmentStatus.pending, _count: { _all: 2 } },
    ]);
    prisma.user.groupBy.mockResolvedValue([
      { status: 'active', _count: { _all: 10 } },
      { status: 'suspended', _count: { _all: 2 } },
      { status: 'deleted', _count: { _all: 4 } },
    ]);
    prisma.booking.groupBy
      .mockResolvedValueOnce([
        { status: BookingStatus.confirmed, _count: { _all: 2 } },
        { status: BookingStatus.checked_in, _count: { _all: 1 } },
        { status: BookingStatus.cancelled, _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { establishmentId: 'e1', _count: { _all: 6 } },
        { establishmentId: 'e2', _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { establishmentId: 'e1', _sum: { totalMinor: 185000n } },
        { establishmentId: 'e2', _sum: { totalMinor: 30000n } },
      ]);
    prisma.booking.count.mockResolvedValue(3);
    prisma.booking.aggregate.mockResolvedValue({
      _sum: { totalMinor: 215000n },
    });
    prisma.booking.findMany.mockResolvedValue([recentBookingRow()]);
    prisma.establishment.findMany.mockResolvedValue([
      { id: 'e1', name: 'Sede Norte' },
      { id: 'e2', name: 'Sede Sur' },
    ]);

    service = new DashboardService(prisma as unknown as PrismaService);
  });

  it('calcula por defecto los últimos 30 días locales incluido hoy', async () => {
    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(dashboard.period).toEqual({
      from: '2026-05-17',
      to: '2026-06-15',
      timezone: DASHBOARD_TIMEZONE,
    });

    const periodWhere = prisma.booking.groupBy.mock.calls[0][0].where;
    expect(periodWhere.startsAt).toEqual({
      gte: new Date('2026-05-17T05:00:00.000Z'),
      lt: new Date('2026-06-16T05:00:00.000Z'),
    });
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: {
        startsAt: {
          gte: new Date('2026-06-15T05:00:00.000Z'),
          lt: new Date('2026-06-16T05:00:00.000Z'),
        },
      },
    });
  });

  it('usa America/Bogota, no UTC, para la frontera del día local', () => {
    const beforeMidnight = new Date('2026-06-16T04:59:59.000Z');
    const afterMidnight = new Date('2026-06-16T05:00:00.000Z');

    expect(resolveDashboardPeriod(undefined, undefined, beforeMidnight).today).toBe(
      '2026-06-15',
    );
    expect(resolveDashboardPeriod(undefined, undefined, afterMidnight).today).toBe(
      '2026-06-16',
    );
  });

  it('respeta from y to explícitos y admite hasta 366 días', async () => {
    const dashboard = await service.getPlatformDashboard(
      { from: '2025-01-01', to: '2026-01-01' },
      NOW,
    );

    expect(dashboard.period).toEqual({
      from: '2025-01-01',
      to: '2026-01-01',
      timezone: DASHBOARD_TIMEZONE,
    });
    expect(DASHBOARD_MAX_PERIOD_DAYS).toBe(366);
    expect(prisma.booking.groupBy.mock.calls[0][0].where.startsAt).toEqual({
      gte: new Date('2025-01-01T05:00:00.000Z'),
      lt: new Date('2026-01-02T05:00:00.000Z'),
    });
  });

  it('rechaza from > to, periodos mayores a 366 días y fechas imposibles', async () => {
    await expectAppError(
      service.getPlatformDashboard({ from: '2026-06-16', to: '2026-06-15' }, NOW),
      400,
      'VALIDATION_ERROR',
    );

    await expectAppError(
      service.getPlatformDashboard(
        { from: '2025-01-01', to: '2026-01-02' },
        NOW,
      ),
      400,
      'VALIDATION_ERROR',
    );

    await expectAppError(
      service.getPlatformDashboard({ from: '2026-02-30' }, NOW),
      400,
      'VALIDATION_ERROR',
    );

    await expectAppError(
      service.getPlatformDashboard({ to: '2026-13-01' }, NOW),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('suma ingresos con confirmed, checked_in, completed y no_show', async () => {
    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(dashboard.bookings.revenueMinor).toBe('215000');
    expect(dashboard.bookings.currency).toBe(DASHBOARD_CURRENCY);
    expect(prisma.booking.aggregate).toHaveBeenCalledWith({
      where: {
        startsAt: {
          gte: new Date('2026-05-17T05:00:00.000Z'),
          lt: new Date('2026-06-16T05:00:00.000Z'),
        },
        status: {
          in: [
            BookingStatus.confirmed,
            BookingStatus.checked_in,
            BookingStatus.completed,
            BookingStatus.no_show,
          ],
        },
      },
      _sum: { totalMinor: true },
    });
  });

  it('cuenta reservas del periodo, del día y por estado (con ceros)', async () => {
    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(dashboard.bookings.period).toBe(4);
    expect(dashboard.bookings.today).toBe(3);
    expect(dashboard.bookings.byStatus).toMatchObject({
      confirmed: 2,
      checked_in: 1,
      cancelled: 1,
      completed: 0,
      no_show: 0,
      pending_payment: 0,
      expired: 0,
    });
  });

  it('ordena y limita el top de sedes por reservas y desempata por ingresos y nombre', async () => {
    prisma.booking.groupBy
      .mockReset()
      .mockResolvedValueOnce([
        { status: BookingStatus.confirmed, _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { establishmentId: 'e-one', _count: { _all: 6 } },
        { establishmentId: 'e-two', _count: { _all: 6 } },
        { establishmentId: 'e-three', _count: { _all: 6 } },
        { establishmentId: 'e-four', _count: { _all: 6 } },
        { establishmentId: 'e-five', _count: { _all: 2 } },
        { establishmentId: 'e-six', _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { establishmentId: 'e-one', _sum: { totalMinor: 100n } },
        { establishmentId: 'e-two', _sum: { totalMinor: 300n } },
        { establishmentId: 'e-three', _sum: { totalMinor: 300n } },
        { establishmentId: 'e-four', _sum: { totalMinor: 300n } },
        { establishmentId: 'e-five', _sum: { totalMinor: 0n } },
        { establishmentId: 'e-six', _sum: { totalMinor: 0n } },
      ]);
    prisma.establishment.findMany.mockResolvedValue([
      { id: 'e-one', name: 'Zeta' },
      { id: 'e-two', name: 'Zeta' },
      { id: 'e-three', name: 'Alfa' },
      { id: 'e-four', name: 'Beta' },
      { id: 'e-five', name: 'Cinco' },
      { id: 'e-six', name: 'Seis' },
    ]);

    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(dashboard.topEstablishments).toHaveLength(5);
    expect(dashboard.topEstablishments.map((row) => row.id)).toEqual([
      'e-three',
      'e-four',
      'e-two',
      'e-one',
      'e-five',
    ]);
    expect(dashboard.topEstablishments[0]).toEqual({
      id: 'e-three',
      name: 'Alfa',
      bookings: 6,
      revenueMinor: '300',
    });
  });

  it('mapea las reservas recientes con sede, espacio, jugador y BigInt como string', async () => {
    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(dashboard.recentBookings).toEqual([
      {
        id: 'booking-1',
        publicCode: 'BK-1',
        status: BookingStatus.confirmed,
        startsAt: '2026-06-15T15:00:00.000Z',
        createdAt: '2026-06-14T12:00:00.000Z',
        totalMinor: '123000',
        currency: 'COP',
        establishment: { id: 'e1', name: 'Sede Norte' },
        space: { id: 's1', name: 'Cancha 1' },
        player: { id: 'u1', displayName: 'Ana' },
      },
    ]);
  });

  it('cuenta sedes por estado y excluye usuarios eliminados del total', async () => {
    const dashboard = await service.getPlatformDashboard({}, NOW);

    expect(dashboard.establishments).toEqual({
      total: 6,
      active: 3,
      suspended: 1,
      pending: 2,
    });
    expect(dashboard.users).toEqual({ total: 12, active: 10, suspended: 2 });
  });

  it('usa horas locales de Bogotá para el instante inicial y final', () => {
    const period = resolveDashboardPeriod('2026-06-15', '2026-06-15', NOW);

    expect(period.fromInstant.getTime()).toBe(
      Date.parse('2026-06-15T00:00:00.000-05:00'),
    );
    expect(period.toInstant.getTime()).toBe(
      Date.parse('2026-06-16T00:00:00.000-05:00'),
    );
    expect(period.toInstant.getTime() - period.fromInstant.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(period.todayStart.getTime()).toBe(period.fromInstant.getTime());
    expect(period.todayStart.getTime()).toBe(
      Date.parse('2026-06-15T00:00:00.000-05:00'),
    );
  });
});
