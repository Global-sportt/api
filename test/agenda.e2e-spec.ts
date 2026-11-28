import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BookingStatus,
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  PaymentMethod,
} from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
  type QueryPlan,
} from '../src/common/authz/authorization.types';
import { RoutePolicyRegistry } from '../src/common/authz/route-policy.registry';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import {
  getZonedDateTimeParts,
  wallClockToUtc,
} from '../src/common/time/zoned-time';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

/**
 * Daily agenda e2e.
 *
 * Fixtures are provisioned with Prisma so the suite does not depend on the
 * booking-creation flow. The local day boundaries are the core of the feature:
 * a 23:30 booking in America/Bogota and a 06:00 booking of the next local day
 * share the same UTC date, so a naive UTC-day query would mix them.
 */

const ORIGIN = 'http://localhost:5173';
const TIMEZONE = 'America/Bogota';
const MISSING_ESTABLISHMENT = '00000000-0000-4000-8000-000000000000';

type PrincipalName =
  | 'anon'
  | 'playerA'
  | 'staffE1'
  | 'ownerE1'
  | 'ownerE2'
  | 'admin';

interface FixtureUser {
  id: string;
  email: string;
  token: string;
}

function scopedPdp(): AuthorizationService {
  return {
    async can(principal, resourceKind, action, resource): Promise<boolean> {
      const scope = principal.permissions[`${resourceKind}:${action}`];
      if (!scope) return false;
      if (scope === 'platform') return true;
      if (scope === 'establishment') {
        return (
          typeof principal.establishmentId === 'string' &&
          resource?.establishmentId === principal.establishmentId
        );
      }
      if (scope === 'own') {
        return resource?.playerId === principal.userId;
      }
      return false;
    },
    async plan(principal, resourceKind, action): Promise<QueryPlan> {
      const scope = principal.permissions[`${resourceKind}:${action}`];
      if (!scope) return { kind: PLAN_KIND.ALWAYS_DENIED };
      if (scope === 'platform') return { kind: PLAN_KIND.ALWAYS_ALLOWED };
      if (scope === 'establishment') {
        return {
          kind: PLAN_KIND.CONDITIONAL,
          condition: {
            expression: {
              operator: 'eq',
              operands: [
                { value: principal.establishmentId ?? null },
                { variable: 'request.resource.attr.establishmentId' },
              ],
            },
          },
        };
      }
      return {
        kind: PLAN_KIND.CONDITIONAL,
        condition: {
          expression: {
            operator: 'eq',
            operands: [
              { value: principal.userId },
              { variable: 'request.resource.attr.playerId' },
            ],
          },
        },
      };
    },
  };
}

let app: INestApplication;
let prisma: PrismaService;
let e1: string;
let e2: string;
let spaceAlpha: string;
let alphaSlug: string;
let spaceBeta: string;
let spaceE2: string;
let date: string;
let nextDate: string;

const users: Partial<Record<PrincipalName, FixtureUser>> = {};

const bookings: {
  alpha0900?: string;
  alpha1200?: string;
  alpha2330?: string;
  nextDay0600?: string;
  otherEstablishment?: string;
} = {};

function server() {
  return app.getHttpServer();
}

function tokenFor(userId: string): string {
  return sign(
    { sub: userId, sid: randomUUID(), typ: 'access' },
    process.env.JWT_ACCESS_SECRET as string,
    {
      algorithm: 'HS256',
      issuer: process.env.JWT_ISSUER,
      audience: process.env.JWT_AUDIENCE,
      expiresIn: 900,
      jwtid: randomUUID(),
    },
  );
}

function auth(
  requestBuilder: request.Test,
  principal: PrincipalName,
): request.Test {
  if (principal === 'anon') return requestBuilder.set('Origin', ORIGIN);
  const user = users[principal];
  if (!user) throw new Error(`Falta el fixture ${principal}`);
  return requestBuilder
    .set('Authorization', `Bearer ${user.token}`)
    .set('Origin', ORIGIN);
}

function formatDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  return [parts.year, parts.month, parts.day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

function plusDays(value: string, days: number): string {
  const probe = new Date(`${value}T00:00:00.000Z`);
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}

function localInstant(value: string, minutes: number): Date {
  return wallClockToUtc(value, minutes, TIMEZONE).instant;
}

function expectProblem(
  response: request.Response,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(code);
}

describe('Agenda diaria por establecimiento (HTTP e2e)', () => {
  beforeAll(async () => {
    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (process.env.E2E_REAL_CERBOS !== '1') {
      builder.overrideProvider(AUTHORIZATION_SERVICE).useValue(scopedPdp());
    }

    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService), { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const playerGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'player' },
      select: { id: true },
    });
    const adminGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'platform-admin' },
      select: { id: true },
    });

    const e1Row = await prisma.establishment.create({
      data: {
        name: 'Agenda E1',
        slug: `agenda-e1-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'Agenda E2',
        slug: `agenda-e2-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    e1 = e1Row.id;
    e2 = e2Row.id;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1);
      await provisionEstablishmentGroups(tx, e2);
    });

    async function createUser(
      label: string,
      options: { admin?: boolean; displayName?: string } = {},
    ): Promise<FixtureUser> {
      const email = `agenda-${label}-${suffix}@example.test`;
      const user = await prisma.user.create({
        data: {
          email,
          ...(options.displayName
            ? { profile: { create: { displayName: options.displayName } } }
            : {}),
        },
        select: { id: true },
      });
      await prisma.userGlobalGroup.createMany({
        data: [
          {
            userId: user.id,
            groupId: playerGroup.id,
            groupScope: GroupScope.global,
          },
          ...(options.admin
            ? [
                {
                  userId: user.id,
                  groupId: adminGroup.id,
                  groupScope: GroupScope.global,
                },
              ]
            : []),
        ],
      });
      return { id: user.id, email, token: tokenFor(user.id) };
    }

    users.playerA = await createUser('player', { displayName: 'Jugador Agenda' });
    users.staffE1 = await createUser('staff');
    users.ownerE1 = await createUser('owner1');
    users.ownerE2 = await createUser('owner2');
    users.admin = await createUser('admin', { admin: true });

    async function addMembership(
      userId: string,
      establishmentId: string,
      slug: 'owner' | 'staff',
    ): Promise<void> {
      const group = await prisma.securityGroup.findFirstOrThrow({
        where: { establishmentId, slug },
        select: { id: true },
      });
      const membership = await prisma.membership.create({
        data: { userId, establishmentId, status: MembershipStatus.active },
        select: { id: true },
      });
      await prisma.membershipGroup.create({
        data: {
          membershipId: membership.id,
          groupId: group.id,
          establishmentId,
        },
      });
    }

    await addMembership(users.staffE1.id, e1, 'staff');
    await addMembership(users.ownerE1.id, e1, 'owner');
    await addMembership(users.ownerE2.id, e2, 'owner');

    // Local "today + 30 days": derived from the establishment timezone so the
    // test never depends on the machine clock's UTC date.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 30);
    date = formatDate(getZonedDateTimeParts(base, TIMEZONE));
    nextDate = plusDays(date, 1);

    // Beta is created first to prove the response orders by name, not by
    // insertion order.
    const beta = await prisma.space.create({
      data: {
        establishmentId: e1,
        name: 'Cancha Beta',
        slug: `cancha-beta-${suffix}`,
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
      },
      select: { id: true },
    });
    spaceBeta = beta.id;

    const alpha = await prisma.space.create({
      data: {
        establishmentId: e1,
        name: 'Cancha Alfa',
        slug: `cancha-alfa-${suffix}`,
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
      },
      select: { id: true },
    });
    spaceAlpha = alpha.id;
    alphaSlug = `cancha-alfa-${suffix}`;

    const external = await prisma.space.create({
      data: {
        establishmentId: e2,
        name: 'Cancha Externa',
        slug: `cancha-externa-${suffix}`,
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
      },
      select: { id: true },
    });
    spaceE2 = external.id;

    async function createBooking(input: {
      establishmentId: string;
      spaceId: string;
      startsAt: Date;
      status: BookingStatus;
      totalMinor: bigint;
    }): Promise<string> {
      const row = await prisma.booking.create({
        data: {
          publicCode: `AG${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`,
          establishmentId: input.establishmentId,
          spaceId: input.spaceId,
          playerId: users.playerA!.id,
          createdByUserId: users.staffE1!.id,
          startsAt: input.startsAt,
          endsAt: new Date(input.startsAt.getTime() + 60 * 60_000),
          status: input.status,
          paymentMethod: PaymentMethod.cash,
          totalMinor: input.totalMinor,
          currency: 'COP',
        },
        select: { id: true },
      });
      return row.id;
    }

    bookings.alpha0900 = await createBooking({
      establishmentId: e1,
      spaceId: spaceAlpha,
      startsAt: localInstant(date, 9 * 60),
      status: BookingStatus.confirmed,
      totalMinor: 30_000n,
    });
    bookings.alpha1200 = await createBooking({
      establishmentId: e1,
      spaceId: spaceAlpha,
      startsAt: localInstant(date, 12 * 60),
      status: BookingStatus.cancelled,
      totalMinor: 20_000n,
    });
    // 23:30 local is 04:30 UTC of the next date: it must stay in `date`.
    bookings.alpha2330 = await createBooking({
      establishmentId: e1,
      spaceId: spaceAlpha,
      startsAt: localInstant(date, 23 * 60 + 30),
      status: BookingStatus.checked_in,
      totalMinor: 25_000n,
    });
    // 06:00 of the next local date is also on the same UTC date as 23:30.
    bookings.nextDay0600 = await createBooking({
      establishmentId: e1,
      spaceId: spaceAlpha,
      startsAt: localInstant(nextDate, 6 * 60),
      status: BookingStatus.confirmed,
      totalMinor: 10_000n,
    });
    bookings.otherEstablishment = await createBooking({
      establishmentId: e2,
      spaceId: spaceE2,
      startsAt: localInstant(date, 10 * 60),
      status: BookingStatus.confirmed,
      totalMinor: 99_900n,
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.establishment.deleteMany({
        where: { id: { in: [e1, e2].filter(Boolean) } },
      });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: Object.values(users)
              .map((user) => user?.id)
              .filter((id): id is string => typeof id === 'string'),
          },
        },
      });
    }
    if (app) await app.close();
  });

  it('registra la ruta con política booking:read', () => {
    const route = app
      .get(RoutePolicyRegistry)
      .inventory()
      .find(
        (candidate) =>
          candidate.path === '/establishments/:establishmentId/agenda',
      );

    expect(route).toMatchObject({
      httpMethod: 'GET',
      policy: 'authorize',
      permission: 'booking:read',
    });
  });

  it('agrupa por espacio, incluye espacios vacíos y respeta la fecha local', async () => {
    const response = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/agenda?date=${date}`,
      ),
      'staffE1',
    ).expect(200);

    expect(response.body).toMatchObject({
      date,
      timezone: TIMEZONE,
      currency: 'COP',
    });

    // Every space of the establishment, ordered by name; the other
    // establishment's space never appears.
    expect(
      (response.body.spaces as Array<{ name: string }>).map(
        (space) => space.name,
      ),
    ).toEqual(['Cancha Alfa', 'Cancha Beta']);

    const alpha = response.body.spaces[0] as {
      id: string;
      slug: string;
      bookings: Array<Record<string, unknown>>;
    };
    const beta = response.body.spaces[1] as {
      id: string;
      bookings: unknown[];
    };

    expect(alpha.id).toBe(spaceAlpha);
    expect(alpha.slug).toBe(alphaSlug);
    expect(beta.id).toBe(spaceBeta);
    expect(beta.bookings).toEqual([]);

    // Bookings ordered by startsAt; the 23:30 booking belongs to this date and
    // the next day's 06:00 booking does not.
    expect(alpha.bookings.map((booking) => booking.id)).toEqual([
      bookings.alpha0900,
      bookings.alpha1200,
      bookings.alpha2330,
    ]);

    expect(alpha.bookings[0]).toEqual({
      id: bookings.alpha0900,
      publicCode: expect.any(String),
      startsAt: localInstant(date, 9 * 60).toISOString(),
      endsAt: localInstant(date, 10 * 60).toISOString(),
      status: BookingStatus.confirmed,
      totalMinor: '30000',
      currency: 'COP',
      player: {
        id: users.playerA!.id,
        displayName: 'Jugador Agenda',
        email: users.playerA!.email,
      },
      space: {
        id: spaceAlpha,
        name: 'Cancha Alfa',
        slug: alphaSlug,
      },
    });

    expect(alpha.bookings[2]).toMatchObject({
      id: bookings.alpha2330,
      startsAt: localInstant(date, 23 * 60 + 30).toISOString(),
      status: BookingStatus.checked_in,
    });

    const totals = response.body.totals as {
      bookings: number;
      revenueMinor: string;
      byStatus: Record<string, number>;
    };
    expect(totals).toEqual({
      bookings: 3,
      // confirmed 30000 + checked_in 25000; the cancelled booking is excluded.
      revenueMinor: '55000',
      byStatus: {
        pending_payment: 0,
        confirmed: 1,
        checked_in: 1,
        completed: 0,
        cancelled: 1,
        expired: 0,
        no_show: 0,
      },
    });
    expect(alpha.bookings.length + beta.bookings.length).toBe(totals.bookings);
  });

  it('frontera de día: la reserva de 23:30 local no aparece en el día siguiente', async () => {
    const response = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/agenda?date=${nextDate}`,
      ),
      'staffE1',
    ).expect(200);

    const returned = (
      response.body.spaces as Array<{ bookings: Array<{ id: string }> }>
    ).flatMap((space) => space.bookings);

    expect(returned.map((booking) => booking.id)).toEqual([
      bookings.nextDay0600,
    ]);
    expect(returned.map((booking) => booking.id)).not.toContain(
      bookings.alpha2330,
    );
    expect(response.body.totals).toMatchObject({
      bookings: 1,
      revenueMinor: '10000',
      byStatus: { confirmed: 1 },
    });
  });

  it('matriz de autorización: anon 401, jugador 403, staff y dueño 200, otra sede 403', async () => {
    const path = `/api/v1/establishments/${e1}/agenda?date=${date}`;
    const expected: Array<{
      principal: PrincipalName;
      status: number;
      code?: string;
    }> = [
      { principal: 'anon', status: 401, code: 'UNAUTHENTICATED' },
      { principal: 'playerA', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'staffE1', status: 200 },
      { principal: 'ownerE1', status: 200 },
      { principal: 'ownerE2', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'admin', status: 200 },
    ];

    for (const { principal, status, code } of expected) {
      const response = await auth(request(server()).get(path), principal);
      expect(response.status).toBe(status);
      if (code) expect(response.body.code).toBe(code);
      if (status === 200) {
        expect(response.body.date).toBe(date);
        expect(
          (response.body.spaces as Array<{ name: string }>).map(
            (space) => space.name,
          ),
        ).toEqual(['Cancha Alfa', 'Cancha Beta']);
      }
    }
  });

  it('una sede inexistente responde 404 y nunca filtra datos de otra sede', async () => {
    const missing = await auth(
      request(server()).get(
        `/api/v1/establishments/${MISSING_ESTABLISHMENT}/agenda?date=${date}`,
      ),
      'staffE1',
    ).expect(404);
    expectProblem(missing, 404, 'ESTABLISHMENT_NOT_FOUND');

    // E2 has a booking on the same local date; E1's agenda must not include it.
    const e1Agenda = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/agenda?date=${date}`,
      ),
      'staffE1',
    ).expect(200);
    const ids = (
      e1Agenda.body.spaces as Array<{ bookings: Array<{ id: string }> }>
    ).flatMap((space) => space.bookings.map((booking) => booking.id));
    expect(ids).not.toContain(bookings.otherEstablishment);

    const e2Agenda = await auth(
      request(server()).get(
        `/api/v1/establishments/${e2}/agenda?date=${date}`,
      ),
      'ownerE2',
    ).expect(200);
    expect(
      (e2Agenda.body.spaces as Array<{ name: string }>).map(
        (space) => space.name,
      ),
    ).toEqual(['Cancha Externa']);
    expect(e2Agenda.body.totals).toMatchObject({
      bookings: 1,
      revenueMinor: '99900',
    });
  });

  it('valida el formato y la existencia real de la fecha', async () => {
    const base = `/api/v1/establishments/${e1}/agenda`;

    for (const query of [
      '',
      '?date=27-11-2026',
      '?date=2026-02-30',
      `?date=${date}&unknown=1`,
    ]) {
      const response = await auth(
        request(server()).get(`${base}${query}`),
        'staffE1',
      ).expect(400);
      expectProblem(response, 400, 'VALIDATION_ERROR');
    }
  });

  it('el listado de tenant acepta date y filtra por día local', async () => {
    const next = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/bookings?date=${nextDate}`,
      ),
      'staffE1',
    ).expect(200);
    expect((next.body as Array<{ id: string }>).map((booking) => booking.id)).toEqual(
      [bookings.nextDay0600],
    );

    const current = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/bookings?date=${date}`,
      ),
      'ownerE1',
    ).expect(200);
    expect(
      (current.body as Array<{ id: string }>).map((booking) => booking.id),
    ).toEqual([bookings.alpha0900, bookings.alpha1200, bookings.alpha2330]);

    const invalid = await auth(
      request(server()).get(
        `/api/v1/establishments/${e1}/bookings?date=2026-02-30`,
      ),
      'staffE1',
    ).expect(400);
    expectProblem(invalid, 400, 'VALIDATION_ERROR');
  });

  it('no cambia el contrato de /me/bookings: date se ignora', async () => {
    const response = await auth(
      request(server()).get(`/api/v1/me/bookings?date=${date}`),
      'playerA',
    ).expect(200);

    const ids = (response.body as Array<{ id: string }>).map(
      (booking) => booking.id,
    );
    // The filtered date still returns the booking of the next local day.
    expect(ids).toContain(bookings.nextDay0600);
    expect(ids).toContain(bookings.alpha2330);
    expect((response.body as Array<{ playerId: string }>).every(
      (booking) => booking.playerId === users.playerA!.id,
    )).toBe(true);
  });
});
