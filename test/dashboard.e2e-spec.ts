import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BookingStatus,
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
  UserStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
} from '../src/common/authz/authorization.types';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import { RoutePolicyRegistry } from '../src/common/authz/route-policy.registry';
import { wallClockToUtc } from '../src/common/time/zoned-time';
import { AppConfigService } from '../src/config/app-config.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

/**
 * Platform dashboard e2e.
 *
 * Fixtures are written directly with Prisma. The period under test is a fixed
 * past month (2020-01) so the aggregates do not depend on the current date or
 * on data seeded by other suites. `today` is exercised by creating one booking
 * inside the current America/Bogota day and comparing against the API response
 * captured immediately before.
 */

const ORIGIN = 'http://localhost:5173';
const TIMEZONE = 'America/Bogota';
const PERIOD_FROM = '2020-01-01';
const PERIOD_TO = '2020-01-31';
const PERIOD_DATE = '2020-01-15';

const scopePdp: AuthorizationService = {
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
    return false;
  },
  async plan() {
    return { kind: PLAN_KIND.ALWAYS_DENIED };
  },
};

type PrincipalName = 'anon' | 'player' | 'owner' | 'admin';

interface FixtureUser {
  id: string;
  email: string;
  token: string;
}

interface StatusBaseline {
  active: number;
  suspended: number;
  pending: number;
}

let app: INestApplication;
let prisma: PrismaService;
let e1: { id: string; name: string };
let e2: { id: string; name: string };
let e3: { id: string };
let e4: { id: string };
let spaceE1: string;
let spaceE2: string;
let establishmentBaseline: StatusBaseline;
let usersBaseline: { active: number; suspended: number };
let playerDisplayName: string;
let playerId: string;
let suspendedUserId: string;

const users: Partial<Record<PrincipalName, FixtureUser>> = {};

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

function getDashboard(principal: PrincipalName, query = '') {
  return auth(
    request(server()).get(`/api/v1/admin/dashboard${query}`),
    principal,
  );
}

async function createUser(
  label: string,
  playerGroupId: string,
  options: {
    adminGroupId?: string;
    status?: UserStatus;
    displayName?: string;
  } = {},
): Promise<FixtureUser> {
  const user = await prisma.user.create({
    data: {
      email: `dashboard-${label}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.test`,
      ...(options.status ? { status: options.status } : {}),
      ...(options.displayName
        ? { profile: { create: { displayName: options.displayName } } }
        : {}),
    },
    select: { id: true, email: true },
  });

  await prisma.userGlobalGroup.createMany({
    data: [
      { userId: user.id, groupId: playerGroupId, groupScope: GroupScope.global },
      ...(options.adminGroupId
        ? [
            {
              userId: user.id,
              groupId: options.adminGroupId,
              groupScope: GroupScope.global,
            },
          ]
        : []),
    ],
  });

  return { ...user, token: tokenFor(user.id) };
}

async function addOwnerMembership(
  userId: string,
  establishmentId: string,
): Promise<void> {
  const group = await prisma.securityGroup.findFirstOrThrow({
    where: { establishmentId, slug: 'owner' },
    select: { id: true },
  });
  const membership = await prisma.membership.create({
    data: { userId, establishmentId, status: MembershipStatus.active },
    select: { id: true },
  });
  await prisma.membershipGroup.create({
    data: { membershipId: membership.id, groupId: group.id, establishmentId },
  });
}

async function createSpace(
  establishmentId: string,
  slug: string,
  name: string,
): Promise<string> {
  const space = await prisma.space.create({
    data: { establishmentId, slug, name, sport: 'futbol' },
    select: { id: true },
  });
  return space.id;
}

async function createBooking(input: {
  establishmentId: string;
  spaceId: string;
  playerId: string;
  status: BookingStatus;
  totalMinor: bigint;
  hour: number;
  date: string;
  publicCode: string;
}): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      publicCode: input.publicCode,
      establishmentId: input.establishmentId,
      spaceId: input.spaceId,
      playerId: input.playerId,
      createdByUserId: input.playerId,
      startsAt: wallClockToUtc(
        input.date,
        input.hour * 60,
        TIMEZONE,
      ).instant,
      endsAt: wallClockToUtc(
        input.date,
        (input.hour + 1) * 60,
        TIMEZONE,
      ).instant,
      status: input.status,
      totalMinor: input.totalMinor,
      currency: 'COP',
      ...(input.status === BookingStatus.pending_payment
        ? { expiresAt: new Date(`${input.date}T00:00:00.000Z`) }
        : {}),
    },
    select: { id: true },
  });
  return booking.id;
}

function bogotaToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addDaysToDateOnly(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function expectProblem(
  response: request.Response,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(code);
}

describe('Tablero de plataforma (HTTP e2e)', () => {
  beforeAll(async () => {
    const builder = Test.createTestingModule({ imports: [AppModule] });

    if (process.env.E2E_REAL_CERBOS !== '1') {
      builder.overrideProvider(AUTHORIZATION_SERVICE).useValue(scopePdp);
    }

    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(AppConfigService), { swagger: false });
    await app.init();
    prisma = app.get(PrismaService);

    // Snapshot before this suite writes anything: other suites share the
    // database and may leave rows behind.
    const establishmentRows = await prisma.establishment.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    establishmentBaseline = { active: 0, suspended: 0, pending: 0 };
    for (const row of establishmentRows) {
      establishmentBaseline[row.status] = row._count._all;
    }

    const userRows = await prisma.user.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    usersBaseline = { active: 0, suspended: 0 };
    for (const row of userRows) {
      if (row.status === UserStatus.active) usersBaseline.active = row._count._all;
      if (row.status === UserStatus.suspended) {
        usersBaseline.suspended = row._count._all;
      }
    }

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const playerGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'player' },
      select: { id: true },
    });
    const adminGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: null, slug: 'platform-admin' },
      select: { id: true },
    });

    e1 = await prisma.establishment.create({
      data: {
        name: `Tablero Norte ${suffix}`,
        slug: `tablero-norte-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, name: true },
    });
    e2 = await prisma.establishment.create({
      data: {
        name: `Tablero Sur ${suffix}`,
        slug: `tablero-sur-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, name: true },
    });
    e3 = await prisma.establishment.create({
      data: {
        name: `Tablero Suspendida ${suffix}`,
        slug: `tablero-suspendida-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.suspended,
      },
      select: { id: true },
    });
    e4 = await prisma.establishment.create({
      data: {
        name: `Tablero Pendiente ${suffix}`,
        slug: `tablero-pendiente-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.pending,
      },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1.id);
      await provisionEstablishmentGroups(tx, e2.id);
    });

    playerDisplayName = `Jugador Tablero ${suffix}`;
    users.admin = await createUser('admin', playerGroup.id, {
      adminGroupId: adminGroup.id,
    });
    users.owner = await createUser('owner', playerGroup.id);
    users.player = await createUser('player', playerGroup.id, {
      displayName: playerDisplayName,
    });
    suspendedUserId = (
      await createUser('suspended', playerGroup.id, {
        status: UserStatus.suspended,
      })
    ).id;

    await addOwnerMembership(users.owner.id, e1.id);

    spaceE1 = await createSpace(e1.id, 'cancha-norte', 'Cancha Norte');
    spaceE2 = await createSpace(e2.id, 'cancha-sur', 'Cancha Sur');

    playerId = users.player.id;
    const fixtures: Array<{
      establishmentId: string;
      spaceId: string;
      status: BookingStatus;
      totalMinor: bigint;
      hour: number;
    }> = [
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.confirmed, totalMinor: 100000n, hour: 8 },
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.checked_in, totalMinor: 50000n, hour: 9 },
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.completed, totalMinor: 25000n, hour: 10 },
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.cancelled, totalMinor: 99999n, hour: 11 },
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.no_show, totalMinor: 10000n, hour: 12 },
      { establishmentId: e1.id, spaceId: spaceE1, status: BookingStatus.pending_payment, totalMinor: 7000n, hour: 13 },
      { establishmentId: e2.id, spaceId: spaceE2, status: BookingStatus.confirmed, totalMinor: 30000n, hour: 8 },
      { establishmentId: e2.id, spaceId: spaceE2, status: BookingStatus.expired, totalMinor: 4000n, hour: 9 },
    ];

    let index = 0;
    for (const fixture of fixtures) {
      index += 1;
      await createBooking({
        ...fixture,
        playerId,
        date: PERIOD_DATE,
        publicCode: `DASH-${suffix}-${index}`,
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.establishment.deleteMany({
        where: {
          id: {
            in: [e1?.id, e2?.id, e3?.id, e4?.id].filter(
              (id): id is string => typeof id === 'string',
            ),
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [
              ...Object.values(users)
                .map((user) => user?.id)
                .filter((id): id is string => typeof id === 'string'),
              ...(suspendedUserId ? [suspendedUserId] : []),
            ],
          },
        },
      });
    }
    if (app) await app.close();
  });

  describe('Autorización', () => {
    const matrix: Array<{
      principal: PrincipalName;
      status: number;
      code?: string;
    }> = [
      { principal: 'anon', status: 401, code: 'UNAUTHENTICATED' },
      { principal: 'player', status: 403, code: 'PERMISSION_DENIED' },
      { principal: 'owner', status: 403, code: 'PERMISSION_DENIED' },
      { principal: 'admin', status: 200 },
    ];

    it.each(matrix)(
      'GET /admin/dashboard · $principal → $status',
      async ({ principal, status, code }) => {
        const response = await getDashboard(
          principal,
          `?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
        );

        expect(response.status).toBe(status);
        if (code) expect(response.body.code).toBe(code);

        if (status === 403) {
          // A tenant role never receives aggregate data, not even a partial body.
          expect(response.body.establishments).toBeUndefined();
          expect(response.body.bookings).toBeUndefined();
        }
      },
    );

    it('registra la ruta con report:read en el inventario de arranque', () => {
      const registry = app.get(RoutePolicyRegistry);
      const routes = registry.validate();
      const route = routes.find(
        (candidate) =>
          candidate.httpMethod === 'GET' &&
          candidate.path === '/admin/dashboard',
      );

      expect(route).toMatchObject({
        controller: 'DashboardController',
        policy: 'authorize',
        permission: 'report:read',
      });
    });
  });

  describe('Periodo', () => {
    it('por defecto son los últimos 30 días locales incluido hoy', async () => {
      const before = bogotaToday();
      const response = await getDashboard('admin').expect(200);
      const after = bogotaToday();

      expect(response.body.period.timezone).toBe(TIMEZONE);
      expect([before, after]).toContain(response.body.period.to);
      expect(response.body.period.from).toBe(
        addDaysToDateOnly(response.body.period.to, -29),
      );
    });

    it.each([
      {
        label: 'from posterior a to',
        query: '?from=2020-02-01&to=2020-01-01',
      },
      {
        label: 'rango de 367 días',
        query: '?from=2019-01-01&to=2020-01-02',
      },
      {
        label: 'fecha imposible',
        query: '?from=2020-02-30&to=2020-03-01',
      },
      {
        label: 'formato inválido',
        query: '?from=2020-1-1&to=2020-02-01',
      },
    ])('rechaza $label con 400 VALIDATION_ERROR', async ({ query }) => {
      const response = await getDashboard('admin', query).expect(400);
      expectProblem(response, 400, 'VALIDATION_ERROR');
    });
  });

  describe('Agregados', () => {
    it('cuadra sedes, usuarios y reservas con las fixtures sembradas', async () => {
      const response = await getDashboard(
        'admin',
        `?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
      ).expect(200);

      expect(response.body.period).toEqual({
        from: PERIOD_FROM,
        to: PERIOD_TO,
        timezone: TIMEZONE,
      });

      expect(response.body.establishments).toEqual({
        total:
          establishmentBaseline.active +
          establishmentBaseline.suspended +
          establishmentBaseline.pending +
          4,
        active: establishmentBaseline.active + 2,
        suspended: establishmentBaseline.suspended + 1,
        pending: establishmentBaseline.pending + 1,
      });

      expect(response.body.users).toEqual({
        total: usersBaseline.active + usersBaseline.suspended + 4,
        active: usersBaseline.active + 3,
        suspended: usersBaseline.suspended + 1,
      });

      expect(response.body.bookings).toEqual({
        period: 8,
        today: expect.any(Number),
        byStatus: {
          pending_payment: 1,
          confirmed: 2,
          checked_in: 1,
          completed: 1,
          cancelled: 1,
          expired: 1,
          no_show: 1,
        },
        revenueMinor: '215000',
        currency: 'COP',
      });

      expect(response.body.topEstablishments).toHaveLength(2);
      expect(response.body.topEstablishments[0]).toEqual({
        id: e1.id,
        name: e1.name,
        bookings: 6,
        revenueMinor: '185000',
      });
      expect(response.body.topEstablishments[1]).toEqual({
        id: e2.id,
        name: e2.name,
        bookings: 2,
        revenueMinor: '30000',
      });
    });

    it('cuenta en today la reserva del día local actual y la expone en recientes', async () => {
      const before = await getDashboard(
        'admin',
        `?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
      ).expect(200);

      const today = bogotaToday();
      const publicCode = `DASH-TODAY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const bookingId = await createBooking({
        establishmentId: e1.id,
        spaceId: spaceE1,
        playerId,
        status: BookingStatus.confirmed,
        totalMinor: 42000n,
        hour: 10,
        date: today,
        publicCode,
      });

      const after = await getDashboard(
        'admin',
        `?from=${PERIOD_FROM}&to=${PERIOD_TO}`,
      ).expect(200);

      expect(after.body.bookings.today).toBe(before.body.bookings.today + 1);
      // The new booking starts today, outside the fixed 2020 period.
      expect(after.body.bookings.period).toBe(before.body.bookings.period);

      expect(after.body.recentBookings.length).toBeLessThanOrEqual(10);
      const timestamps = after.body.recentBookings.map(
        (booking: { createdAt: string }) => Date.parse(booking.createdAt),
      );
      expect([...timestamps].sort((a: number, b: number) => b - a)).toEqual(
        timestamps,
      );

      const recent = after.body.recentBookings.find(
        (booking: { id: string }) => booking.id === bookingId,
      );
      expect(recent).toEqual(
        expect.objectContaining({
          id: bookingId,
          publicCode,
          status: BookingStatus.confirmed,
          startsAt: wallClockToUtc(today, 10 * 60, TIMEZONE).instant.toISOString(),
          totalMinor: '42000',
          currency: 'COP',
          establishment: { id: e1.id, name: e1.name },
          space: { id: spaceE1, name: 'Cancha Norte' },
          player: { id: playerId, displayName: playerDisplayName },
        }),
      );
    });
  });
});
