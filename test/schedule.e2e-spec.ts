import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
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
import {
  dayOfWeekForDateOnly,
  wallClockToUtc,
} from '../src/common/time/zoned-time';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

/**
 * HTTP e2e for the weekly operating grid and the date exceptions.
 *
 * Fixtures are created with Prisma and access tokens are signed with the test
 * secret, as in spaces.e2e-spec.ts. `E2E_REAL_CERBOS=1` runs the same cases
 * against the real Cerbos PDP.
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

type PrincipalName = 'anon' | 'player' | 'staffE1' | 'ownerE1' | 'ownerE2' | 'admin';

let app: INestApplication;
let prisma: PrismaService;
let e1: string;
let e2: string;
let e1Slug: string;
let spaceE1: string;
let spaceE2: string;
let date: string;
let dayOfWeek: number;

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
    data: { email: `schedule-${label}-${suffix}@example.test` },
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

function hoursPath(establishmentId = e1, spaceId = spaceE1): string {
  return `/api/v1/establishments/${establishmentId}/spaces/${spaceId}/operating-hours`;
}

function exceptionsPath(
  establishmentId = e1,
  spaceId = spaceE1,
  exceptionDate = date,
): string {
  return `/api/v1/establishments/${establishmentId}/spaces/${spaceId}/schedule-exceptions/${exceptionDate}`;
}

function expectProblem(
  response: request.Response,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.body.code).toBe(code);
}

describe('Grilla de horarios y excepciones (HTTP e2e)', () => {
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
        name: 'Horarios Norte',
        slug: `horarios-norte-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, slug: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'Horarios Sur',
        slug: `horarios-sur-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, slug: true },
    });
    e1 = e1Row.id;
    e1Slug = e1Row.slug;
    e2 = e2Row.id;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1);
      await provisionEstablishmentGroups(tx, e2);
    });

    users.player = await createUser('player', suffix, playerGroup.id, adminGroup.id);
    users.staffE1 = await createUser('staff', suffix, playerGroup.id, adminGroup.id);
    users.ownerE1 = await createUser('owner1', suffix, playerGroup.id, adminGroup.id);
    users.ownerE2 = await createUser('owner2', suffix, playerGroup.id, adminGroup.id);
    users.admin = await createUser('admin', suffix, playerGroup.id, adminGroup.id, true);

    await addMembership(users.staffE1.id, e1, 'staff');
    await addMembership(users.ownerE1.id, e1, 'owner');
    await addMembership(users.ownerE2.id, e2, 'owner');

    // A date far enough in the future keeps the fixture valid over time.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 30);
    date = base.toISOString().slice(0, 10);
    dayOfWeek = dayOfWeekForDateOnly(date);

    const space1 = await prisma.space.create({
      data: {
        establishmentId: e1,
        name: 'Cancha Horarios',
        slug: 'cancha-horarios',
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
        operatingHours: {
          create: [
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
          ],
        },
      },
      select: { id: true },
    });
    spaceE1 = space1.id;

    const space2 = await prisma.space.create({
      data: {
        establishmentId: e2,
        name: 'Cancha Sur',
        slug: 'cancha-sur',
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
      },
      select: { id: true },
    });
    spaceE2 = space2.id;
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

  describe('GET/PUT /operating-hours', () => {
    it('el dueño consulta la grilla inicial', async () => {
      const response = await auth(request(server()).get(hoursPath()), 'ownerE1').expect(200);

      expect(response.body.hours).toEqual([
        { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
      ]);
    });

    it('el dueño reemplaza la grilla con dos franjas del mismo día', async () => {
      const response = await auth(request(server()).put(hoursPath()), 'ownerE1')
        .send({
          hours: [
            { dayOfWeek, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
          ],
        })
        .expect(200);

      expect(response.body.hours).toEqual([
        { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
        { dayOfWeek, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
      ]);

      const persisted = await prisma.operatingHour.findMany({
        where: { spaceId: spaceE1 },
        orderBy: { opensAtMinutes: 'asc' },
        select: { dayOfWeek: true, opensAtMinutes: true, closesAtMinutes: true },
      });
      expect(persisted).toEqual([
        { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
        { dayOfWeek, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
      ]);
    });

    it('rechaza cruces del mismo día con 400 y detalle de las franjas', async () => {
      const response = await auth(request(server()).put(hoursPath()), 'ownerE1')
        .send({
          hours: [
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
            { dayOfWeek, opensAtMinutes: 11 * 60, closesAtMinutes: 14 * 60 },
          ],
        })
        .expect(400);

      expectProblem(response, 400, 'VALIDATION_ERROR');
      expect(response.body.message).toContain('09:00-12:00');
      expect(response.body.message).toContain('11:00-14:00');
      expect(response.body.details).toEqual([
        expect.objectContaining({
          dayOfWeek,
          constraints: ['overlap'],
          ranges: [
            { opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
            { opensAtMinutes: 11 * 60, closesAtMinutes: 14 * 60 },
          ],
        }),
      ]);

      // The rejected PUT must not touch the persisted grid.
      const persisted = await prisma.operatingHour.count({ where: { spaceId: spaceE1 } });
      expect(persisted).toBe(2);
    });

    it('rechaza aperturas duplicadas y franjas invertidas', async () => {
      const duplicate = await auth(request(server()).put(hoursPath()), 'ownerE1')
        .send({
          hours: [
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 12 * 60 },
          ],
        })
        .expect(400);
      expectProblem(duplicate, 400, 'VALIDATION_ERROR');
      expect(duplicate.body.details).toEqual([
        expect.objectContaining({ constraints: ['duplicate'] }),
      ]);

      const inverted = await auth(request(server()).put(hoursPath()), 'ownerE1')
        .send({
          hours: [
            { dayOfWeek, opensAtMinutes: 15 * 60, closesAtMinutes: 14 * 60 },
          ],
        })
        .expect(400);
      expectProblem(inverted, 400, 'VALIDATION_ERROR');
      expect(inverted.body.message).toContain('15:00-14:00');
    });

    it('rechaza más de 50 franjas con 400', async () => {
      const hours = Array.from({ length: 51 }, (_, index) => ({
        dayOfWeek: index % 7,
        opensAtMinutes: (index % 20) * 60,
        closesAtMinutes: (index % 20) * 60 + 30,
      }));

      const response = await auth(request(server()).put(hoursPath()), 'ownerE1')
        .send({ hours })
        .expect(400);
      expectProblem(response, 400, 'VALIDATION_ERROR');
      expect(response.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'hours' })]),
      );
    });
  });

  describe('Disponibilidad con varias franjas', () => {
    it('la disponibilidad pública refleja las dos franjas del día', async () => {
      const response = await request(server())
        .get(`/api/v1/public/establishments/${e1Slug}/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(200);

      const space = response.body.spaces.find(
        (row: { id: string }) => row.id === spaceE1,
      );
      expect(space).toBeDefined();
      expect(space.slots.map((slot: { startsAt: string }) => slot.startsAt)).toEqual([
        wallClockToUtc(date, 9 * 60, TIMEZONE).instant.toISOString(),
        wallClockToUtc(date, 10 * 60, TIMEZONE).instant.toISOString(),
        wallClockToUtc(date, 14 * 60, TIMEZONE).instant.toISOString(),
        wallClockToUtc(date, 15 * 60, TIMEZONE).instant.toISOString(),
      ]);
    });
  });

  describe('Excepciones por fecha', () => {
    it('crea una excepción cerrada y la lista en el rango', async () => {
      const created = await auth(
        request(server()).put(exceptionsPath()),
        'ownerE1',
      )
        .send({ isClosed: true, reason: 'Mantenimiento' })
        .expect(200);

      expect(created.body).toEqual(
        expect.objectContaining({
          date,
          isClosed: true,
          opensAtMinutes: null,
          closesAtMinutes: null,
          reason: 'Mantenimiento',
        }),
      );

      const list = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=${date}&to=${date}`,
        ),
        'ownerE1',
      ).expect(200);
      expect(list.body.exceptions).toEqual([
        expect.objectContaining({ date, isClosed: true }),
      ]);
    });

    it('una excepción cerrada deja la disponibilidad sin slots', async () => {
      const response = await request(server())
        .get(`/api/v1/public/establishments/${e1Slug}/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(200);

      const space = response.body.spaces.find(
        (row: { id: string }) => row.id === spaceE1,
      );
      expect(space.slots).toEqual([]);
    });

    it('una excepción con horario reemplaza la grilla regular', async () => {
      const updated = await auth(
        request(server()).put(exceptionsPath()),
        'ownerE1',
      )
        .send({
          isClosed: false,
          opensAtMinutes: 20 * 60,
          closesAtMinutes: 22 * 60,
          reason: 'Evento',
        })
        .expect(200);

      expect(updated.body).toEqual(
        expect.objectContaining({
          date,
          isClosed: false,
          opensAtMinutes: 20 * 60,
          closesAtMinutes: 22 * 60,
        }),
      );

      const response = await request(server())
        .get(`/api/v1/public/establishments/${e1Slug}/availability?date=${date}`)
        .set('Origin', ORIGIN)
        .expect(200);

      const space = response.body.spaces.find(
        (row: { id: string }) => row.id === spaceE1,
      );
      expect(space.slots.map((slot: { startsAt: string }) => slot.startsAt)).toEqual([
        wallClockToUtc(date, 20 * 60, TIMEZONE).instant.toISOString(),
        wallClockToUtc(date, 21 * 60, TIMEZONE).instant.toISOString(),
      ]);
    });

    it('valida el cuerpo de la excepción', async () => {
      const closedWithHours = await auth(
        request(server()).put(exceptionsPath()),
        'ownerE1',
      )
        .send({ isClosed: true, opensAtMinutes: 9 * 60, closesAtMinutes: 10 * 60 })
        .expect(400);
      expectProblem(closedWithHours, 400, 'VALIDATION_ERROR');

      const missingCloses = await auth(
        request(server()).put(exceptionsPath()),
        'ownerE1',
      )
        .send({ isClosed: false, opensAtMinutes: 9 * 60 })
        .expect(400);
      expectProblem(missingCloses, 400, 'VALIDATION_ERROR');

      const inverted = await auth(
        request(server()).put(exceptionsPath()),
        'ownerE1',
      )
        .send({ isClosed: false, opensAtMinutes: 12 * 60, closesAtMinutes: 11 * 60 })
        .expect(400);
      expectProblem(inverted, 400, 'VALIDATION_ERROR');
      expect(inverted.body.message).toContain('12:00-11:00');
    });

    it('valida el rango de fechas de la consulta', async () => {
      const inverted = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=2026-12-31&to=2026-12-01`,
        ),
        'ownerE1',
      ).expect(400);
      expectProblem(inverted, 400, 'VALIDATION_ERROR');

      const tooWide = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=2026-01-01&to=2027-01-02`,
        ),
        'ownerE1',
      ).expect(400);
      expectProblem(tooWide, 400, 'VALIDATION_ERROR');

      const impossible = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=2026-02-30&to=2026-03-10`,
        ),
        'ownerE1',
      ).expect(400);
      expectProblem(impossible, 400, 'VALIDATION_ERROR');
    });

    it('elimina la excepción y luego responde 404', async () => {
      await auth(request(server()).delete(exceptionsPath()), 'ownerE1').expect(204);

      const list = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=${date}&to=${date}`,
        ),
        'ownerE1',
      ).expect(200);
      expect(list.body.exceptions).toEqual([]);

      const missing = await auth(
        request(server()).delete(exceptionsPath()),
        'ownerE1',
      ).expect(404);
      expectProblem(missing, 404, 'SCHEDULE_EXCEPTION_NOT_FOUND');
    });
  });

  describe('Aislamiento entre establecimientos', () => {
    it('una cancha de otra sede responde 404 en la grilla y las excepciones', async () => {
      const grid = await auth(
        request(server()).get(hoursPath(e1, spaceE2)),
        'ownerE1',
      ).expect(404);
      expectProblem(grid, 404, 'SPACE_NOT_FOUND');

      const exception = await auth(
        request(server()).put(exceptionsPath(e1, spaceE2)),
        'ownerE1',
      )
        .send({ isClosed: true })
        .expect(404);
      expectProblem(exception, 404, 'SPACE_NOT_FOUND');
    });

    it('un dueño de otra sede no entra por el path del establecimiento ajeno', async () => {
      const response = await auth(
        request(server()).get(hoursPath(e2, spaceE2)),
        'ownerE1',
      ).expect(403);
      expectProblem(response, 403, 'TENANT_FORBIDDEN');
    });
  });

  describe('Autorización', () => {
    const readMatrix: Array<{
      principal: PrincipalName;
      status: number;
      code?: string;
    }> = [
      { principal: 'anon', status: 401, code: 'UNAUTHENTICATED' },
      { principal: 'player', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'staffE1', status: 200 },
      { principal: 'ownerE1', status: 200 },
      { principal: 'ownerE2', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'admin', status: 200 },
    ];

    it.each(readMatrix)(
      'GET /operating-hours · $principal → $status',
      async ({ principal, status, code }) => {
        const response = await auth(
          request(server()).get(hoursPath()),
          principal,
        );

        expect(response.status).toBe(status);
        if (code) expect(response.body.code).toBe(code);
        if (status === 200) {
          expect(Array.isArray(response.body.hours)).toBe(true);
        }
      },
    );

    const writeMatrix: Array<{
      principal: PrincipalName;
      status: number;
      code?: string;
    }> = [
      { principal: 'anon', status: 401, code: 'UNAUTHENTICATED' },
      { principal: 'player', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'staffE1', status: 403, code: 'PERMISSION_DENIED' },
      { principal: 'ownerE1', status: 200 },
      { principal: 'ownerE2', status: 403, code: 'TENANT_FORBIDDEN' },
      { principal: 'admin', status: 200 },
    ];

    it.each(writeMatrix)(
      'PUT /operating-hours · $principal → $status',
      async ({ principal, status, code }) => {
        const response = await auth(
          request(server()).put(hoursPath()),
          principal,
        ).send({
          hours: [
            { dayOfWeek, opensAtMinutes: 9 * 60, closesAtMinutes: 11 * 60 },
            { dayOfWeek, opensAtMinutes: 14 * 60, closesAtMinutes: 16 * 60 },
          ],
        });

        expect(response.status).toBe(status);
        if (code) expect(response.body.code).toBe(code);
      },
    );

    it('staff puede leer las excepciones pero no escribirlas', async () => {
      await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/schedule-exceptions?from=${date}&to=${date}`,
        ),
        'staffE1',
      ).expect(200);

      const denied = await auth(
        request(server()).put(exceptionsPath()),
        'staffE1',
      )
        .send({ isClosed: true })
        .expect(403);
      expectProblem(denied, 403, 'PERMISSION_DENIED');

      const deniedDelete = await auth(
        request(server()).delete(exceptionsPath()),
        'staffE1',
      ).expect(403);
      expectProblem(deniedDelete, 403, 'PERMISSION_DENIED');
    });

    it('establecimiento inexistente responde 404', async () => {
      const response = await auth(
        request(server()).get(hoursPath(MISSING_ESTABLISHMENT, spaceE1)),
        'ownerE1',
      ).expect(404);
      expectProblem(response, 404, 'ESTABLISHMENT_NOT_FOUND');
    });
  });
});
