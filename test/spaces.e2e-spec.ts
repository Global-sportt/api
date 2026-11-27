import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BookingStatus,
  EstablishmentStatus,
  GroupScope,
  MembershipStatus,
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
} from '../src/common/authz/authorization.types';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import { dayOfWeekForDateOnly, wallClockToUtc } from '../src/common/time/zoned-time';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

/**
 * F-14 / T5 — HTTP e2e for spaces and availability.
 *
 * Fixtures are created directly with Prisma (users, memberships, groups,
 * spaces and the booking that must disappear from availability) so this spec
 * does not depend on the booking-creation flow owned by A5. Access tokens are
 * signed with the test secret: the auth middleware verifies them but the spec
 * never needs the registration/login flow.
 */

const ORIGIN = 'http://localhost:5173';
const TIMEZONE = 'America/Bogota';
const MISSING_ESTABLISHMENT = '00000000-0000-4000-8000-000000000000';

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

interface FixtureUser {
  id: string;
  email: string;
  token: string;
}

type PrincipalName = 'anon' | 'playerA' | 'staffE1' | 'ownerE1' | 'ownerE2' | 'admin';

let app: INestApplication;
let prisma: PrismaService;
let e1: { id: string; slug: string };
let e2: { id: string; slug: string };
let inactive: { id: string; slug: string };
let spaceE1: string;
let spaceE2: string;
let spaceInactive: string;
let date: string;
let bookedStart: string;
let bookedEnd: string;

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

function auth(requestBuilder: request.Test, principal: PrincipalName): request.Test {
  if (principal === 'anon') return requestBuilder.set('Origin', ORIGIN);
  const user = users[principal];
  if (!user) throw new Error(`Falta el fixture ${principal}`);
  return requestBuilder
    .set('Authorization', `Bearer ${user.token}`)
    .set('Origin', ORIGIN);
}

async function createUser(
  label: string,
  suffix: string,
  playerGroupId: string,
  adminGroupId: string,
  admin = false,
): Promise<FixtureUser> {
  const user = await prisma.user.create({
    data: { email: `spaces-${label}-${suffix}@example.test` },
    select: { id: true, email: true },
  });

  await prisma.userGlobalGroup.createMany({
    data: [
      { userId: user.id, groupId: playerGroupId, groupScope: GroupScope.global },
      ...(admin
        ? [{ userId: user.id, groupId: adminGroupId, groupScope: GroupScope.global }]
        : []),
    ],
  });

  return { ...user, token: tokenFor(user.id) };
}

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

async function createSpace(
  establishmentId: string,
  slug: string,
  name: string,
): Promise<string> {
  const dayOfWeek = dayOfWeekForDateOnly(date);
  const space = await prisma.space.create({
    data: {
      establishmentId,
      name,
      slug,
      sport: 'futbol',
      slotMinutes: 60,
      bufferMinutes: 0,
      operatingHours: {
        create: [{ dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 }],
      },
    },
    select: { id: true },
  });
  return space.id;
}

function expectProblem(
  response: request.Response,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(code);
}

describe('Spaces y disponibilidad (T5, HTTP e2e)', () => {
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
        name: 'T5 Norte',
        slug: `t5-norte-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, slug: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'T5 Sur',
        slug: `t5-sur-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, slug: true },
    });
    const inactiveRow = await prisma.establishment.create({
      data: {
        name: 'T5 Suspendida',
        slug: `t5-suspendida-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.suspended,
      },
      select: { id: true, slug: true },
    });
    e1 = e1Row;
    e2 = e2Row;
    inactive = inactiveRow;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1.id);
      await provisionEstablishmentGroups(tx, e2.id);
      await provisionEstablishmentGroups(tx, inactive.id);
    });

    users.playerA = await createUser('player', suffix, playerGroup.id, adminGroup.id);
    users.staffE1 = await createUser('staff', suffix, playerGroup.id, adminGroup.id);
    users.ownerE1 = await createUser('owner1', suffix, playerGroup.id, adminGroup.id);
    users.ownerE2 = await createUser('owner2', suffix, playerGroup.id, adminGroup.id);
    users.admin = await createUser(
      'admin',
      suffix,
      playerGroup.id,
      adminGroup.id,
      true,
    );

    await addMembership(users.staffE1.id, e1.id, 'staff');
    await addMembership(users.ownerE1.id, e1.id, 'owner');
    await addMembership(users.ownerE2.id, e2.id, 'owner');

    // A local date far enough in the future to remain valid after F-01 fixes.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 30);
    date = base.toISOString().slice(0, 10);

    spaceE1 = await createSpace(e1.id, 'cancha-1', 'Cancha 1');
    spaceE2 = await createSpace(e2.id, 'cancha-2', 'Cancha 2');
    spaceInactive = await createSpace(
      inactive.id,
      'cancha-3',
      'Cancha 3',
    );

    bookedStart = wallClockToUtc(date, 10 * 60, TIMEZONE).instant.toISOString();
    bookedEnd = wallClockToUtc(date, 11 * 60, TIMEZONE).instant.toISOString();

    await prisma.booking.create({
      data: {
        publicCode: `T5-${suffix}`,
        establishmentId: e1.id,
        spaceId: spaceE1,
        playerId: users.playerA.id,
        createdByUserId: users.playerA.id,
        startsAt: new Date(bookedStart),
        endsAt: new Date(bookedEnd),
        status: BookingStatus.confirmed,
        totalMinor: 0n,
        currency: 'COP',
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.establishment.deleteMany({
        where: { id: { in: [e1?.id, e2?.id, inactive?.id].filter(Boolean) } },
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

  describe('RT-02 — disponibilidad pública', () => {
    const principals: PrincipalName[] = [
      'anon',
      'playerA',
      'staffE1',
      'ownerE1',
      'ownerE2',
      'admin',
    ];

    it.each(principals)(
      'RT-02 · GET /public/establishments/:slug/availability · %s → 200',
      async (principal) => {
        const response = await auth(
          request(server()).get(
            `/api/v1/public/establishments/${e1.slug}/availability?date=${date}`,
          ),
          principal,
        ).expect(200);

        expect(response.body).toEqual(
          expect.objectContaining({
            date,
            timezone: TIMEZONE,
            currency: 'COP',
          }),
        );
        expect(response.body.spaces).toHaveLength(1);
        expect(response.body.spaces[0].id).toBe(spaceE1);
        expect(response.body.spaces[0].slots.length).toBeGreaterThan(0);
        expect(response.body.slots.length).toBe(
          response.body.spaces[0].slots.length,
        );
        expect(response.body.slots[0]).toEqual(
          expect.objectContaining({
            spaceId: spaceE1,
            spaceSlug: 'cancha-1',
            available: true,
          }),
        );
      },
    );

    it('RT-02 · oculta establecimientos suspendidos y slugs inexistentes con 404', async () => {
      const suspended = await request(server())
        .get(`/api/v1/public/establishments/${inactive.slug}/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(404);
      expectProblem(suspended, 404, 'ESTABLISHMENT_NOT_FOUND');

      const missing = await request(server())
        .get(`/api/v1/public/establishments/no-existe-t5/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(404);
      expectProblem(missing, 404, 'ESTABLISHMENT_NOT_FOUND');
    });

    it('RT-02 · rechaza una fecha imposible con 400 VALIDATION_ERROR', async () => {
      const response = await request(server())
        .get(
          `/api/v1/public/establishments/${e1.slug}/availability?date=2026-02-30`,
        )
        .set('Origin', ORIGIN)
        .expect(400);
      expectProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('RT-02 · una cancha de otro tenant en el filtro spaceId responde 404', async () => {
      const response = await request(server())
        .get(
          `/api/v1/public/establishments/${e1.slug}/availability?date=${date}&spaceId=${spaceE2}`,
        )
        .set('Origin', ORIGIN)
        .expect(404);
      expectProblem(response, 404, 'SPACE_NOT_FOUND');
    });
  });

  describe('RT-09 — GET /establishments/:id/spaces', () => {
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

    it.each(expected)(
      'RT-09 · GET /establishments/E1/spaces · $principal → $status',
      async ({ principal, status, code }) => {
        const response = await auth(
          request(server()).get(`/api/v1/establishments/${e1.id}/spaces`),
          principal,
        );

        expect(response.status).toBe(status);
        if (code) expect(response.body.code).toBe(code);

        if (status === 200) {
          expect(response.body).toEqual([
            expect.objectContaining({
              id: spaceE1,
              name: 'Cancha 1',
              slug: 'cancha-1',
              status: 'active',
              operatingHours: [
                expect.objectContaining({
                  opensAtMinutes: 540,
                  closesAtMinutes: 720,
                }),
              ],
            }),
          ]);
        }
      },
    );

    it('RT-09/NEG-04 · anónimo no llega a TenantGuard ni a Cerbos (401)', async () => {
      const response = await request(server())
        .get(`/api/v1/establishments/${e1.id}/spaces`)
        .set('Origin', ORIGIN)
        .expect(401);
      expectProblem(response, 401, 'UNAUTHENTICATED');
    });

    it('RT-09 · establecimiento inexistente → 404 ESTABLISHMENT_NOT_FOUND', async () => {
      const response = await auth(
        request(server()).get(
          `/api/v1/establishments/${MISSING_ESTABLISHMENT}/spaces`,
        ),
        'ownerE1',
      ).expect(404);
      expectProblem(response, 404, 'ESTABLISHMENT_NOT_FOUND');
    });
  });

  describe('NEG-02 — aislamiento tenant en spaces', () => {
    it('NEG-02 · staff/owner de E1 reciben 403 T en E2 y admin entra sin membresía', async () => {
      for (const principal of ['staffE1', 'ownerE1'] as const) {
        const denied = await auth(
          request(server()).get(`/api/v1/establishments/${e2.id}/spaces`),
          principal,
        ).expect(403);
        expectProblem(denied, 403, 'TENANT_FORBIDDEN');
      }

      const admin = await auth(
        request(server()).get(`/api/v1/establishments/${e2.id}/spaces`),
        'admin',
      ).expect(200);
      expect(admin.body).toEqual([
        expect.objectContaining({ id: spaceE2, slug: 'cancha-2' }),
      ]);
    });

    it('NEG-02 · owner de E1 no lee la availability de E2 (403 T)', async () => {
      const denied = await auth(
        request(server()).get(
          `/api/v1/establishments/${e2.id}/spaces/${spaceE2}/availability?date=${date}`,
        ),
        'ownerE1',
      ).expect(403);
      expectProblem(denied, 403, 'TENANT_FORBIDDEN');
    });
  });

  describe('Availability tenant', () => {
    it('RT-09 · owner recibe los slots de su cancha con precio y divisa del servidor', async () => {
      const response = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1.id}/spaces/${spaceE1}/availability?date=${date}`,
        ),
        'ownerE1',
      ).expect(200);

      expect(response.body).toEqual(
        expect.objectContaining({
          date,
          timezone: TIMEZONE,
          currency: 'COP',
          spaceId: spaceE1,
        }),
      );
      expect(response.body.slots.length).toBeGreaterThan(0);
      expect(response.body.slots[0]).toEqual(
        expect.objectContaining({
          priceMinor: expect.any(String),
          currency: 'COP',
          available: true,
        }),
      );
    });

    it('T5-AVAIL-DATE · una fecha imposible responde 400 VALIDATION_ERROR', async () => {
      const response = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1.id}/spaces/${spaceE1}/availability?date=2026-02-30`,
        ),
        'ownerE1',
      ).expect(400);
      expectProblem(response, 400, 'VALIDATION_ERROR');
    });

    it('T5-AVAIL-CROSS · una cancha de E2 bajo E1 responde 404 SPACE_NOT_FOUND', async () => {
      const response = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1.id}/spaces/${spaceE2}/availability?date=${date}`,
        ),
        'ownerE1',
      ).expect(404);
      expectProblem(response, 404, 'SPACE_NOT_FOUND');
    });

    it('T5-AVAIL-EMPTY · establecimiento suspendido no expone canchas públicas', async () => {
      const response = await request(server())
        .get(
          `/api/v1/public/establishments/${inactive.slug}/availability?date=${date}`,
        )
        .set('Origin', ORIGIN)
        .expect(404);
      expectProblem(response, 404, 'ESTABLISHMENT_NOT_FOUND');

      // The space exists in DB but is unreachable through the public route.
      expect(
        await prisma.space.findUnique({ where: { id: spaceInactive } }),
      ).not.toBeNull();
    });
  });

  describe('Disponibilidad excluye la franja reservada', () => {
    it('T5-AVAIL-BOOKED · público y tenant omiten el slot con reserva confirmed', async () => {
      const publicResponse = await request(server())
        .get(`/api/v1/public/establishments/${e1.slug}/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(200);

      const publicStarts = publicResponse.body.slots.map(
        (slot: { startsAt: string }) => slot.startsAt,
      );
      expect(publicStarts).not.toContain(bookedStart);
      expect(publicStarts).toContain(
        wallClockToUtc(date, 9 * 60, TIMEZONE).instant.toISOString(),
      );
      expect(publicStarts).toContain(
        wallClockToUtc(date, 11 * 60, TIMEZONE).instant.toISOString(),
      );

      const tenantResponse = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1.id}/spaces/${spaceE1}/availability?date=${date}`,
        ),
        'staffE1',
      ).expect(200);

      const tenantStarts = tenantResponse.body.slots.map(
        (slot: { startsAt: string }) => slot.startsAt,
      );
      expect(tenantStarts).not.toContain(bookedStart);
      expect(tenantStarts).toContain(
        wallClockToUtc(date, 9 * 60, TIMEZONE).instant.toISOString(),
      );
    });
  });
});
