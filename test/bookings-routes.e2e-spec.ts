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
import { AppError } from '../src/common/errors/app-error';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
  type QueryPlan,
} from '../src/common/authz/authorization.types';
import { provisionEstablishmentGroups } from '../src/common/authz/establishment-groups';
import { dayOfWeekForDateOnly, wallClockToUtc } from '../src/common/time/zoned-time';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

/**
 * F-05 — HTTP cells RT-03..RT-08 (self and tenant bookings).
 *
 * This spec lives outside `bookings.e2e-spec.ts` (owned by A5 this pass) and
 * provisions its data directly with Prisma. It uses the same six principals as
 * docs/authorization-acceptance-matrix.md §3.
 */

const ORIGIN = 'http://localhost:5173';
const TIMEZONE = 'America/Bogota';

type PrincipalName =
  | 'anon'
  | 'playerA'
  | 'staffE1'
  | 'ownerE1'
  | 'ownerE2'
  | 'admin';

interface FixtureUser {
  id: string;
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
let spaceE1: string;
let date: string;

const users: Partial<Record<PrincipalName, FixtureUser>> = {};
const selfBookings: Partial<Record<PrincipalName, string>> = {};
const tenantBookings: Partial<Record<PrincipalName, string>> = {};

function server() {
  return app.getHttpServer();
}

function tokenFor(
  userId: string,
  extraClaims: Record<string, unknown> = {},
): string {
  return sign(
    { sub: userId, sid: randomUUID(), typ: 'access', ...extraClaims },
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

function slot(minuteOfDay: number): { startsAt: string; endsAt: string } {
  return {
    startsAt: wallClockToUtc(date, minuteOfDay, TIMEZONE).instant.toISOString(),
    endsAt: wallClockToUtc(date, minuteOfDay + 60, TIMEZONE).instant.toISOString(),
  };
}

function expectProblem(
  response: request.Response,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(code);
}

describe('Bookings routes RT-03..RT-08 (HTTP e2e)', () => {
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
        name: 'RT E1',
        slug: `rt-e1-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'RT E2',
        slug: `rt-e2-${suffix}`,
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

    async function createUser(label: string, admin = false): Promise<FixtureUser> {
      const user = await prisma.user.create({
        data: { email: `rt-${label}-${suffix}@example.test` },
        select: { id: true },
      });
      await prisma.userGlobalGroup.createMany({
        data: [
          { userId: user.id, groupId: playerGroup.id, groupScope: GroupScope.global },
          ...(admin
            ? [{ userId: user.id, groupId: adminGroup.id, groupScope: GroupScope.global }]
            : []),
        ],
      });
      return { id: user.id, token: tokenFor(user.id) };
    }

    users.playerA = await createUser('player-a');
    users.staffE1 = await createUser('staff');
    users.ownerE1 = await createUser('owner1');
    users.ownerE2 = await createUser('owner2');
    users.admin = await createUser('admin', true);

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
        data: { membershipId: membership.id, groupId: group.id, establishmentId },
      });
    }

    await addMembership(users.staffE1.id, e1, 'staff');
    await addMembership(users.ownerE1.id, e1, 'owner');
    await addMembership(users.ownerE2.id, e2, 'owner');

    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 30);
    date = base.toISOString().slice(0, 10);

    const space = await prisma.space.create({
      data: {
        establishmentId: e1,
        name: 'RT Cancha',
        slug: 'rt-cancha',
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
        operatingHours: {
          create: [
            {
              dayOfWeek: dayOfWeekForDateOnly(date),
              opensAtMinutes: 9 * 60,
              closesAtMinutes: 18 * 60,
            },
          ],
        },
      },
      select: { id: true },
    });
    spaceE1 = space.id;
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

  it('RT-04: POST /bookings — cinco principals crean su propia reserva y anon recibe 401', async () => {
    const anonymous = await request(server())
      .post('/api/v1/bookings')
      .set('Origin', ORIGIN)
      .send({ spaceId: spaceE1, ...slot(9 * 60) })
      .expect(401);
    expectProblem(anonymous, 401, 'UNAUTHENTICATED');

    const plan: Array<[PrincipalName, number]> = [
      ['playerA', 9 * 60],
      ['staffE1', 10 * 60],
      ['ownerE1', 11 * 60],
      ['ownerE2', 12 * 60],
      ['admin', 13 * 60],
    ];

    for (const [principal, minute] of plan) {
      const response = await auth(
        request(server())
          .post('/api/v1/bookings')
          .send({ spaceId: spaceE1, ...slot(minute) }),
        principal,
      ).expect(201);

      expect(response.body).toEqual(
        expect.objectContaining({
          establishmentId: e1,
          spaceId: spaceE1,
          playerId: users[principal]!.id,
          status: 'confirmed',
        }),
      );
      selfBookings[principal] = response.body.id as string;
    }

    // NEG-01 fixture: a booking owned by staff remains untouched for the IDOR
    // and cancellation checks in RT-05.
    expect(selfBookings.staffE1).toEqual(expect.any(String));
  });

  it('RT-03: GET /me/bookings — cada principal solo ve sus propias reservas', async () => {
    const anonymous = await request(server())
      .get('/api/v1/me/bookings')
      .set('Origin', ORIGIN)
      .expect(401);
    expectProblem(anonymous, 401, 'UNAUTHENTICATED');

    for (const principal of [
      'playerA',
      'staffE1',
      'ownerE1',
      'ownerE2',
      'admin',
    ] as const) {
      const response = await auth(
        request(server()).get('/api/v1/me/bookings'),
        principal,
      ).expect(200);

      expect(response.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: selfBookings[principal] }),
        ]),
      );
      expect(
        (response.body as Array<{ playerId: string }>).every(
          (booking) => booking.playerId === users[principal]!.id,
        ),
      ).toBe(true);
    }

    const playerAList = await auth(
      request(server()).get('/api/v1/me/bookings'),
      'playerA',
    ).expect(200);
    expect(
      playerAList.body.some(
        (booking: { id: string }) => booking.id === selfBookings.staffE1,
      ),
    ).toBe(false);

    // NEG-01: detail of another player's booking is indistinguishable from 404.
    const idor = await auth(
      request(server()).get(`/api/v1/me/bookings/${selfBookings.staffE1}`),
      'playerA',
    ).expect(404);
    expectProblem(idor, 404, 'BOOKING_NOT_FOUND');
  });

  it('RT-05: POST /me/bookings/:id/cancel — cada principal cancela la propia; la ajena 404', async () => {
    const anonymous = await request(server())
      .post(`/api/v1/me/bookings/${selfBookings.playerA}/cancel`)
      .set('Origin', ORIGIN)
      .expect(401);
    expectProblem(anonymous, 401, 'UNAUTHENTICATED');

    // NEG-01: owner cannot cancel another player's booking.
    const idor = await auth(
      request(server()).post(
        `/api/v1/me/bookings/${selfBookings.staffE1}/cancel`,
      ),
      'playerA',
    ).expect(404);
    expectProblem(idor, 404, 'BOOKING_NOT_FOUND');

    const untouched = await prisma.booking.findUniqueOrThrow({
      where: { id: selfBookings.staffE1 },
      select: { status: true },
    });
    expect(untouched.status).toBe(BookingStatus.confirmed);

    for (const principal of [
      'playerA',
      'staffE1',
      'ownerE1',
      'ownerE2',
      'admin',
    ] as const) {
      const response = await auth(
        request(server()).post(
          `/api/v1/me/bookings/${selfBookings[principal]}/cancel`,
        ),
        principal,
      ).expect(200);
      expect(response.body.status).toBe(BookingStatus.cancelled);
    }
  });

  it('RT-06: GET /establishments/E1/bookings — matriz de seis principals', async () => {
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
      const response = await auth(
        request(server()).get(`/api/v1/establishments/${e1}/bookings`),
        principal,
      );
      expect(response.status).toBe(status);
      if (code) expect(response.body.code).toBe(code);
      if (status === 200) {
        expect(
          (response.body as Array<{ establishmentId: string }>).every(
            (booking) => booking.establishmentId === e1,
          ),
        ).toBe(true);
      }
    }
  });

  it('NEG-02: staff/owner de E1 reciben 403 T en bookings de E2; admin entra sin membresía', async () => {
    const randomBooking = randomUUID();
    for (const principal of ['staffE1', 'ownerE1'] as const) {
      const denied = await auth(
        request(server()).get(`/api/v1/establishments/${e2}/bookings`),
        principal,
      ).expect(403);
      expect(denied.body.code).toBe('TENANT_FORBIDDEN');

      const patchDenied = await auth(
        request(server()).patch(
          `/api/v1/establishments/${e2}/bookings/${randomBooking}/status`,
        ),
        principal,
      )
        .send({ status: 'checked_in' })
        .expect(403);
      expect(patchDenied.body.code).toBe('TENANT_FORBIDDEN');
    }

    const admin = await auth(
      request(server()).get(`/api/v1/establishments/${e2}/bookings`),
      'admin',
    ).expect(200);
    expect(admin.body).toEqual([]);
  });

  it('NEG-03 (token claim): un claim establishmentId=E1 en el token no autoriza E2', async () => {
    // The access-token contract does not include an establishment claim. An
    // extra claim signed with the real test secret must still be ignored: the
    // path and the active membership are the only tenant sources.
    const forgedToken = tokenFor(users.staffE1!.id, {
      establishmentId: e1,
    });

    const e1Allowed = await request(server())
      .get(`/api/v1/establishments/${e1}/bookings`)
      .set('Authorization', `Bearer ${forgedToken}`)
      .set('Origin', ORIGIN)
      .expect(200);
    expect(e1Allowed.body).toEqual(expect.any(Array));

    const e2Denied = await request(server())
      .get(`/api/v1/establishments/${e2}/bookings`)
      .set('Authorization', `Bearer ${forgedToken}`)
      .set('Origin', ORIGIN)
      .expect(403);
    expectProblem(e2Denied, 403, 'TENANT_FORBIDDEN');
    expect(e2Denied.body).not.toHaveProperty('bookings');
    expect(e2Denied.body).not.toHaveProperty('data');

    const e2PatchDenied = await request(server())
      .patch(
        `/api/v1/establishments/${e2}/bookings/${randomUUID()}/status`,
      )
      .set('Authorization', `Bearer ${forgedToken}`)
      .set('Origin', ORIGIN)
      .send({ status: 'checked_in' })
      .expect(403);
    expectProblem(e2PatchDenied, 403, 'TENANT_FORBIDDEN');
  });

  it('RT-07: POST /establishments/E1/bookings — staff/owner/admin crean para un jugador; resto 403', async () => {
    const anonymous = await request(server())
      .post(`/api/v1/establishments/${e1}/bookings`)
      .set('Origin', ORIGIN)
      .send({
        spaceId: spaceE1,
        playerId: users.playerA!.id,
        ...slot(14 * 60),
      })
      .expect(401);
    expectProblem(anonymous, 401, 'UNAUTHENTICATED');

    for (const principal of ['playerA', 'ownerE2'] as const) {
      const denied = await auth(
        request(server())
          .post(`/api/v1/establishments/${e1}/bookings`)
          .send({
            spaceId: spaceE1,
            playerId: users.playerA!.id,
            ...slot(14 * 60),
          }),
        principal,
      ).expect(403);
      expect(denied.body.code).toBe('TENANT_FORBIDDEN');
    }

    const allowed: Array<[PrincipalName, number]> = [
      ['staffE1', 15 * 60],
      ['ownerE1', 16 * 60],
      ['admin', 17 * 60],
    ];

    for (const [principal, minute] of allowed) {
      const response = await auth(
        request(server())
          .post(`/api/v1/establishments/${e1}/bookings`)
          .send({
            spaceId: spaceE1,
            playerId: users.playerA!.id,
            ...slot(minute),
          }),
        principal,
      ).expect(201);

      expect(response.body).toEqual(
        expect.objectContaining({
          establishmentId: e1,
          playerId: users.playerA!.id,
          status: 'confirmed',
        }),
      );
      tenantBookings[principal] = response.body.id as string;
    }
  });

  it('RT-08/NEG-03: PATCH status manage — seis principals y establishmentId inyectado rechazado', async () => {
    const pathFor = (id: string | undefined) =>
      `/api/v1/establishments/${e1}/bookings/${id}/status`;

    const injected = await auth(
      request(server()).patch(pathFor(tenantBookings.staffE1)),
      'staffE1',
    )
      .send({ status: 'checked_in', establishmentId: e2 })
      .expect(400);
    expectProblem(injected, 400, 'VALIDATION_ERROR');

    const untouched = await prisma.booking.findUniqueOrThrow({
      where: { id: tenantBookings.staffE1 },
      select: { status: true, establishmentId: true },
    });
    expect(untouched).toEqual({
      status: BookingStatus.confirmed,
      establishmentId: e1,
    });

    const anonymous = await request(server())
      .patch(pathFor(tenantBookings.staffE1))
      .set('Origin', ORIGIN)
      .send({ status: 'checked_in' })
      .expect(401);
    expectProblem(anonymous, 401, 'UNAUTHENTICATED');

    for (const principal of ['playerA', 'ownerE2'] as const) {
      const denied = await auth(
        request(server()).patch(pathFor(tenantBookings.staffE1)),
        principal,
      ).send({ status: 'checked_in' }).expect(403);
      expect(denied.body.code).toBe('TENANT_FORBIDDEN');
    }

    const allowed: PrincipalName[] = ['staffE1', 'ownerE1', 'admin'];
    for (const principal of allowed) {
      const response = await auth(
        request(server()).patch(pathFor(tenantBookings[principal])),
        principal,
      )
        .send({ status: 'checked_in' })
        .expect(200);
      expect(response.body.status).toBe(BookingStatus.checked_in);
    }
  });

  it('NEG-09: borrar un grant invalida la caché y devuelve 403 inmediato; re-otorgar vuelve a 200', async () => {
    const staffGroup = await prisma.securityGroup.findFirstOrThrow({
      where: { establishmentId: e1, slug: 'staff' },
      select: { id: true },
    });
    const manage = await prisma.permission.findUniqueOrThrow({
      where: { code: 'booking:manage' },
      select: { id: true },
    });

    const booking = await prisma.booking.create({
      data: {
        publicCode: `NEG09-${Date.now()}`,
        establishmentId: e1,
        spaceId: spaceE1,
        playerId: users.playerA!.id,
        createdByUserId: users.staffE1!.id,
        startsAt: new Date(slot(14 * 60).startsAt),
        endsAt: new Date(slot(14 * 60).endsAt),
        status: BookingStatus.confirmed,
        totalMinor: 0n,
        currency: 'COP',
      },
      select: { id: true },
    });

    const path = `/api/v1/establishments/${e1}/bookings/${booking.id}/status`;
    // Warm the in-memory permission cache (and move the booking to checked_in).
    await auth(
      request(server()).patch(path),
      'staffE1',
    ).send({ status: 'checked_in' }).expect(200);

    const version = await prisma.authorizationVersion.findUniqueOrThrow({
      where: { id: 1 },
      select: { version: true },
    });

    const grant = await prisma.securityGroupPermission.findUniqueOrThrow({
      where: {
        groupId_permissionId: {
          groupId: staffGroup.id,
          permissionId: manage.id,
        },
      },
      select: { scope: true },
    });

    let afterDeleteVersion = version.version;

    try {
      await prisma.securityGroupPermission.delete({
        where: {
          groupId_permissionId: {
            groupId: staffGroup.id,
            permissionId: manage.id,
          },
        },
      });

      const afterDelete = await prisma.authorizationVersion.findUniqueOrThrow({
        where: { id: 1 },
        select: { version: true },
      });
      expect(afterDelete.version).toBe(version.version + 1n);
      afterDeleteVersion = afterDelete.version;

      const denied = await auth(
        request(server()).patch(path),
        'staffE1',
      ).send({ status: 'completed' }).expect(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');

      const stillCheckedIn = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { status: true },
      });
      expect(stillCheckedIn.status).toBe(BookingStatus.checked_in);
    } finally {
      await prisma.securityGroupPermission.upsert({
        where: {
          groupId_permissionId: {
            groupId: staffGroup.id,
            permissionId: manage.id,
          },
        },
        create: {
          groupId: staffGroup.id,
          permissionId: manage.id,
          scope: grant.scope,
        },
        update: { scope: grant.scope },
      });
    }

    const afterRestore = await prisma.authorizationVersion.findUniqueOrThrow({
      where: { id: 1 },
      select: { version: true },
    });
    // Prisma may implement upsert with more than one SQL statement, so the
    // re-grant contract is "version advances", not a single +1.
    expect(afterRestore.version).toBeGreaterThan(afterDeleteVersion);

    const allowed = await auth(
      request(server()).patch(path),
      'staffE1',
    ).send({ status: 'completed' }).expect(200);
    expect(allowed.body.status).toBe(BookingStatus.completed);
  });

  it('NEG-06: PDP no disponible → 503 AUTHORIZATION_UNAVAILABLE, público sigue 200 y sin escrituras', async () => {
    const before = await prisma.booking.count({
      where: { playerId: users.playerA!.id },
    });
    const establishment = await prisma.establishment.findUniqueOrThrow({
      where: { id: e1 },
      select: { slug: true },
    });

    const builder = Test.createTestingModule({ imports: [AppModule] });
    builder.overrideProvider(AUTHORIZATION_SERVICE).useValue({
      async can(): Promise<boolean> {
        throw new AppError(
          503,
          'AUTHORIZATION_UNAVAILABLE',
          'El servicio de autorización no está disponible.',
        );
      },
      async plan(): Promise<QueryPlan> {
        throw new AppError(
          503,
          'AUTHORIZATION_UNAVAILABLE',
          'El servicio de autorización no está disponible.',
        );
      },
    } satisfies AuthorizationService);

    const moduleRef = await builder.compile();
    const failingApp = moduleRef.createNestApplication();
    configureApp(failingApp, failingApp.get(AppConfigService), {
      swagger: false,
    });
    await failingApp.init();

    try {
      const protectedPaths = [
        { path: '/api/v1/me/bookings', token: users.playerA!.token },
        {
          path: `/api/v1/establishments/${e1}/bookings`,
          token: users.staffE1!.token,
        },
      ];

      for (const { path, token } of protectedPaths) {
        const response = await request(failingApp.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${token}`)
          .set('Origin', ORIGIN)
          .expect(503);

        expect(response.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
        expect(response.body).toEqual(
          expect.objectContaining({
            status: 503,
            code: 'AUTHORIZATION_UNAVAILABLE',
            title: 'Service Unavailable',
            trace_id: expect.any(String),
            path,
          }),
        );
      }

      // POST also fails before the controller/validation layer.
      const writeAttempt = await request(failingApp.getHttpServer())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${users.playerA!.token}`)
        .set('Origin', ORIGIN)
        .send({})
        .expect(503);
      expect(writeAttempt.body.code).toBe('AUTHORIZATION_UNAVAILABLE');

      // Public routes do not depend on the PDP and remain available.
      await request(failingApp.getHttpServer())
        .get(
          `/api/v1/public/establishments/${establishment.slug}/availability?date=${date}`,
        )
        .set('Origin', ORIGIN)
        .expect(200);

      const after = await prisma.booking.count({
        where: { playerId: users.playerA!.id },
      });
      expect(after).toBe(before);
    } finally {
      await failingApp.close();
    }
  });
});
