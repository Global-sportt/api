import { BookingStatus } from '@prisma/client';

// `@cerbos/orm-prisma` imports the ESM-only `@cerbos/core`; unit tests only
// need the `PlanKind` constants at runtime (same shim as test/setup-env.ts).
jest.mock('@cerbos/core', () => ({
  PlanKind: {
    ALWAYS_ALLOWED: 'KIND_ALWAYS_ALLOWED',
    ALWAYS_DENIED: 'KIND_ALWAYS_DENIED',
    CONDITIONAL: 'KIND_CONDITIONAL',
  },
}));

import type { AppLogger } from '../../common/logging/app-logger.service';
import {
  PLAN_KIND,
  type AuthorizationService,
  type AuthorizedPrincipal,
  type PermissionResolver,
  type QueryPlan,
} from '../../common/authz/authorization.types';
import { AppError } from '../../common/errors/app-error';
import { wallClockToUtc } from '../../common/time/zoned-time';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SlotsService } from '../spaces/slots.service';
import { BookingsService } from './bookings.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ESTABLISHMENT_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_A = '44444444-4444-4444-8444-444444444444';
const SPACE_B = '55555555-5555-4555-8555-555555555555';
const PLAYER_ID = '66666666-6666-4666-8666-666666666666';
const TIMEZONE = 'America/Bogota';
const DATE = '2030-01-15';
const NEXT_DATE = '2030-01-16';

const staffPrincipal: AuthorizedPrincipal = {
  userId: USER_ID,
  establishmentId: ESTABLISHMENT_ID,
  permissions: { 'booking:read': 'establishment' },
  isPlatformAdmin: false,
};

interface PrismaMock {
  establishment: { findUnique: jest.Mock };
  space: { findMany: jest.Mock };
  booking: { findMany: jest.Mock };
}

function buildService(plan: QueryPlan = { kind: PLAN_KIND.ALWAYS_ALLOWED }) {
  const prisma: PrismaMock = {
    establishment: { findUnique: jest.fn() },
    space: { findMany: jest.fn() },
    booking: { findMany: jest.fn() },
  };
  const permissions = { resolve: jest.fn().mockResolvedValue(staffPrincipal) };
  const authorization = {
    can: jest.fn().mockResolvedValue(true),
    plan: jest.fn().mockResolvedValue(plan),
  };
  const logger = { raw: { info: jest.fn() }, error: jest.fn() };

  return {
    service: new BookingsService(
      prisma as unknown as PrismaService,
      { generate: jest.fn() } as unknown as SlotsService,
      permissions as unknown as PermissionResolver,
      authorization as unknown as AuthorizationService,
      logger as unknown as AppLogger,
    ),
    prisma,
    permissions,
    authorization,
  };
}

function zoned(minutes: number, date = DATE): Date {
  return wallClockToUtc(date, minutes, TIMEZONE).instant;
}

interface AgendaRowInput {
  id: string;
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
  startsAtMinute: number;
  status?: BookingStatus;
  totalMinor?: bigint;
  displayName?: string | null;
}

function agendaRow(input: AgendaRowInput) {
  return {
    id: input.id,
    publicCode: `BK${input.id.replace(/-/g, '').slice(0, 20).toUpperCase()}`,
    spaceId: input.spaceId,
    startsAt: zoned(input.startsAtMinute),
    endsAt: zoned(input.startsAtMinute + 60),
    status: input.status ?? BookingStatus.confirmed,
    totalMinor: input.totalMinor ?? 10_000n,
    currency: 'COP',
    player: {
      id: PLAYER_ID,
      email: 'player@example.test',
      profile: {
        displayName:
          input.displayName === undefined ? 'Jugador Prueba' : input.displayName,
      },
    },
    space: {
      id: input.spaceId,
      name: input.spaceName,
      slug: input.spaceSlug,
    },
  };
}

function spaceA() {
  return { id: SPACE_A, name: 'Cancha Alfa', slug: 'cancha-alfa' };
}

function spaceB() {
  return { id: SPACE_B, name: 'Cancha Beta', slug: 'cancha-beta' };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<AppError> {
  try {
    await promise;
    throw new Error(`Se esperaba un AppError ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
    return appError;
  }
}

function dayFilter(startsAt: Date, endsAt: Date) {
  return { startsAt: { gte: startsAt, lt: endsAt } };
}

describe('BookingsService — agenda diaria por establecimiento', () => {
  it('resuelve el día local del establecimiento y no usa la medianoche UTC', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });
    prisma.space.findMany.mockResolvedValue([spaceA()]);
    prisma.booking.findMany.mockResolvedValue([]);

    const agenda = await service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE);

    expect(prisma.establishment.findUnique).toHaveBeenCalledWith({
      where: { id: ESTABLISHMENT_ID },
      select: { timezone: true, currency: true },
    });
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {},
            { establishmentId: ESTABLISHMENT_ID },
            dayFilter(zoned(0), zoned(0, NEXT_DATE)),
          ],
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(agenda.timezone).toBe(TIMEZONE);
    expect(agenda.currency).toBe('COP');
    // 00:00 in Bogota is 05:00 UTC; a UTC boundary would start at 00:00Z.
    expect(zoned(0).toISOString()).toBe('2030-01-15T05:00:00.000Z');
    expect(zoned(0, NEXT_DATE).toISOString()).toBe('2030-01-16T05:00:00.000Z');
  });

  it('agrupa por espacio e incluye los espacios sin reservas ordenados por nombre', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });
    prisma.space.findMany.mockResolvedValue([spaceA(), spaceB()]);
    prisma.booking.findMany.mockResolvedValue([
      agendaRow({ id: 'a1', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 540 }),
    ]);

    const agenda = await service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE);

    expect(prisma.space.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { establishmentId: ESTABLISHMENT_ID },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(agenda.spaces.map((space) => space.name)).toEqual([
      'Cancha Alfa',
      'Cancha Beta',
    ]);
    expect(agenda.spaces[0].bookings).toHaveLength(1);
    expect(agenda.spaces[1].bookings).toEqual([]);
    expect(agenda.totals).toMatchObject({ bookings: 1, revenueMinor: '10000' });
  });

  it('calcula totales por estado y suma solo confirmed, checked_in, completed y no_show', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });
    prisma.space.findMany.mockResolvedValue([spaceA(), spaceB()]);
    prisma.booking.findMany.mockResolvedValue([
      agendaRow({ id: 'b1', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 480, status: BookingStatus.confirmed, totalMinor: 30_000n }),
      agendaRow({ id: 'b2', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 540, status: BookingStatus.checked_in, totalMinor: 25_000n }),
      agendaRow({ id: 'b3', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 600, status: BookingStatus.no_show, totalMinor: 15_000n }),
      agendaRow({ id: 'b4', spaceId: SPACE_B, spaceName: 'Cancha Beta', spaceSlug: 'cancha-beta', startsAtMinute: 660, status: BookingStatus.completed, totalMinor: 40_000n }),
      agendaRow({ id: 'b5', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 720, status: BookingStatus.cancelled, totalMinor: 20_000n }),
      agendaRow({ id: 'b6', spaceId: SPACE_A, spaceName: 'Cancha Alfa', spaceSlug: 'cancha-alfa', startsAtMinute: 780, status: BookingStatus.expired, totalMinor: 5_000n }),
      agendaRow({ id: 'b7', spaceId: SPACE_B, spaceName: 'Cancha Beta', spaceSlug: 'cancha-beta', startsAtMinute: 840, status: BookingStatus.pending_payment, totalMinor: 6_000n }),
    ]);

    const agenda = await service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE);

    expect(agenda.totals).toEqual({
      bookings: 7,
      // cancelled/expired/pending_payment are excluded from revenue.
      revenueMinor: '110000',
      byStatus: {
        pending_payment: 1,
        confirmed: 1,
        checked_in: 1,
        completed: 1,
        cancelled: 1,
        expired: 1,
        no_show: 1,
      },
    });

    const returned = agenda.spaces.flatMap((space) => space.bookings);
    expect(agenda.totals.bookings).toBe(returned.length);
    expect(agenda.spaces[0].bookings.map((booking) => booking.id)).toEqual([
      'b1',
      'b2',
      'b3',
      'b5',
      'b6',
    ]);
    expect(agenda.spaces[1].bookings.map((booking) => booking.id)).toEqual([
      'b4',
      'b7',
    ]);
  });

  it('devuelve los campos del contrato por reserva y el jugador con displayName nulo', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });
    prisma.space.findMany.mockResolvedValue([spaceA()]);
    prisma.booking.findMany.mockResolvedValue([
      agendaRow({
        id: 'c1',
        spaceId: SPACE_A,
        spaceName: 'Cancha Alfa',
        spaceSlug: 'cancha-alfa',
        startsAtMinute: 540,
        totalMinor: 12_345n,
        displayName: null,
      }),
    ]);

    const agenda = await service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE);
    const booking = agenda.spaces[0].bookings[0];

    expect(booking).toEqual({
      id: 'c1',
      publicCode: expect.any(String),
      startsAt: zoned(540).toISOString(),
      endsAt: zoned(600).toISOString(),
      status: BookingStatus.confirmed,
      totalMinor: '12345',
      currency: 'COP',
      player: {
        id: PLAYER_ID,
        displayName: null,
        email: 'player@example.test',
      },
      space: { id: SPACE_A, name: 'Cancha Alfa', slug: 'cancha-alfa' },
    });
  });

  it('rechaza fechas que no son días reales antes de consultar la base', async () => {
    const { service, prisma } = buildService();

    for (const invalid of ['2030-02-30', '2030-13-01', '15-01-2030', '']) {
      const error = await expectAppError(
        service.getAgenda(USER_ID, ESTABLISHMENT_ID, invalid),
        400,
        'VALIDATION_ERROR',
      );
      expect(error.details).toEqual([
        { field: 'date', constraints: ['isCalendarDate'] },
      ]);
    }

    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('responde 404 cuando el establecimiento no existe', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue(null);

    await expectAppError(
      service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE),
      404,
      'ESTABLISHMENT_NOT_FOUND',
    );
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('falla cerrado cuando el plan de autorización niega la lectura', async () => {
    const { service, prisma } = buildService({ kind: PLAN_KIND.ALWAYS_DENIED });
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });

    const agenda = await service.getAgenda(USER_ID, ESTABLISHMENT_ID, DATE);

    expect(agenda.spaces).toEqual([]);
    expect(agenda.totals).toEqual({
      bookings: 0,
      revenueMinor: '0',
      byStatus: {
        pending_payment: 0,
        confirmed: 0,
        checked_in: 0,
        completed: 0,
        cancelled: 0,
        expired: 0,
        no_show: 0,
      },
    });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('aplica date al listado de tenant con las fronteras locales', async () => {
    const { service, prisma } = buildService();
    prisma.establishment.findUnique.mockResolvedValue({
      timezone: TIMEZONE,
      currency: 'COP',
    });
    prisma.booking.findMany.mockResolvedValue([]);

    await service.listTenant(USER_ID, ESTABLISHMENT_ID, { date: DATE });

    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {},
            { establishmentId: ESTABLISHMENT_ID },
            dayFilter(zoned(0), zoned(0, NEXT_DATE)),
          ],
        },
      }),
    );
  });

  it('no consulta el establecimiento ni filtra por día cuando el listado de tenant no trae date', async () => {
    const { service, prisma } = buildService();
    prisma.booking.findMany.mockResolvedValue([]);

    await service.listTenant(USER_ID, ESTABLISHMENT_ID, {});

    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
    const call = prisma.booking.findMany.mock.calls[0][0] as {
      where: { AND: unknown[] };
    };
    expect(call.where.AND).toEqual([{}, { establishmentId: ESTABLISHMENT_ID }]);
  });

  it('rechaza date inválido en el listado de tenant', async () => {
    const { service, prisma } = buildService();

    const error = await expectAppError(
      service.listTenant(USER_ID, ESTABLISHMENT_ID, { date: '2030-02-30' }),
      400,
      'VALIDATION_ERROR',
    );
    expect(error.details).toEqual([
      { field: 'date', constraints: ['isCalendarDate'] },
    ]);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('mantiene /me sin filtro de fecha aunque el DTO acepte date', async () => {
    const { service, prisma } = buildService();
    prisma.booking.findMany.mockResolvedValue([]);

    await service.listMine(USER_ID, { date: DATE });

    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
    const call = prisma.booking.findMany.mock.calls[0][0] as {
      where: { AND: unknown[] };
    };
    expect(call.where.AND).toEqual([{}, { playerId: USER_ID }]);
  });
});
