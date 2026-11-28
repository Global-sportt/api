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
 * HTTP e2e for the price grid of a space and its effect on availability and
 * booking prices.
 *
 * Fixtures are created with Prisma and access tokens are signed with the test
 * secret, as in spaces.e2e-spec.ts. `E2E_REAL_CERBOS=1` runs the same cases
 * against the real Cerbos PDP.
 */

const ORIGIN = 'http://localhost:5173';
const TIMEZONE = 'America/Bogota';
const MISSING_ESTABLISHMENT = '00000000-0000-4000-8000-000000000000';

const BASE_PRICE_MINOR = 200_000;
const PEAK_PRICE_MINOR = 30_000;
const UPDATED_PEAK_PRICE_MINOR = 99_000;

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
    async plan() {
      return { kind: PLAN_KIND.ALWAYS_DENIED };
    },
  };
}

interface FixtureUser {
  id: string;
  email: string;
  token: string;
}

type PrincipalName = 'anon' | 'player' | 'staffE1' | 'ownerE1' | 'ownerE2';

interface PriceRuleBody {
  id: string;
  dayOfWeek: number | null;
  startsAtMinutes: number;
  endsAtMinutes: number;
  amountMinor: string;
  currency: string;
  priority: number;
}

let app: INestApplication;
let prisma: PrismaService;
let e1: string;
let e2: string;
let e1Slug: string;
let spaceE1: string;
let spaceE2: string;
let date: string;
let dayOfWeek: number;

let peakRuleId: string | undefined;
let bookingRuleId: string | undefined;
let bookingBaseId: string | undefined;

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
): Promise<FixtureUser> {
  const user = await prisma.user.create({
    data: { email: `price-rules-${label}-${suffix}@example.test` },
    select: { id: true, email: true },
  });

  await prisma.userGlobalGroup.create({
    data: {
      userId: user.id,
      groupId: playerGroupId,
      groupScope: GroupScope.global,
    },
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

function priceRulesPath(
  establishmentId = e1,
  spaceId = spaceE1,
): string {
  return `/api/v1/establishments/${establishmentId}/spaces/${spaceId}/price-rules`;
}

function peakRule(overrides: Record<string, unknown> = {}) {
  return {
    dayOfWeek,
    startsAtMinutes: 10 * 60,
    endsAtMinutes: 11 * 60,
    amountMinor: PEAK_PRICE_MINOR,
    priority: 10,
    currency: 'COP',
    ...overrides,
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

async function publicAvailability(): Promise<request.Response> {
  return request(server())
    .get(`/api/v1/public/establishments/${e1Slug}/availability?date=${date}`)
    .set('Origin', ORIGIN)
    .expect(200);
}

function spaceSlots(response: request.Response): Array<{
  startsAt: string;
  endsAt: string;
  priceMinor: string;
  currency: string;
}> {
  const space = response.body.spaces.find(
    (row: { id: string }) => row.id === spaceE1,
  );
  expect(space).toBeDefined();
  return space.slots;
}

function slotAtMinutes(startsAtMinutes: number) {
  return {
    startsAt: wallClockToUtc(date, startsAtMinutes, TIMEZONE).instant.toISOString(),
    endsAt: wallClockToUtc(date, startsAtMinutes + 60, TIMEZONE).instant.toISOString(),
  };
}

describe('Reglas de precio por franja (HTTP e2e)', () => {
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

    const e1Row = await prisma.establishment.create({
      data: {
        name: 'Precios Norte',
        slug: `precios-norte-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true, slug: true },
    });
    const e2Row = await prisma.establishment.create({
      data: {
        name: 'Precios Sur',
        slug: `precios-sur-${suffix}`,
        timezone: TIMEZONE,
        currency: 'COP',
        status: EstablishmentStatus.active,
      },
      select: { id: true },
    });
    e1 = e1Row.id;
    e1Slug = e1Row.slug;
    e2 = e2Row.id;

    await prisma.$transaction(async (tx) => {
      await provisionEstablishmentGroups(tx, e1);
      await provisionEstablishmentGroups(tx, e2);
    });

    users.player = await createUser('player', suffix, playerGroup.id);
    users.staffE1 = await createUser('staff', suffix, playerGroup.id);
    users.ownerE1 = await createUser('owner1', suffix, playerGroup.id);
    users.ownerE2 = await createUser('owner2', suffix, playerGroup.id);

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
        name: 'Cancha Precios',
        slug: 'cancha-precios',
        sport: 'futbol',
        slotMinutes: 60,
        bufferMinutes: 0,
        basePriceMinor: BigInt(BASE_PRICE_MINOR),
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
        name: 'Cancha Sur Precios',
        slug: 'cancha-sur-precios',
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

  describe('GET/PUT /price-rules', () => {
    it('el dueño consulta una grilla vacía y el staff puede leerla', async () => {
      const owner = await auth(request(server()).get(priceRulesPath()), 'ownerE1')
        .expect(200);
      expect(owner.body).toEqual({ rules: [] });

      const staff = await auth(request(server()).get(priceRulesPath()), 'staffE1')
        .expect(200);
      expect(staff.body).toEqual({ rules: [] });
    });

    it('el dueño reemplaza la grilla y la respuesta respeta la precedencia', async () => {
      const response = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule()] })
        .expect(200);

      expect(response.body.rules).toHaveLength(1);
      expect(response.body.rules[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          dayOfWeek,
          startsAtMinutes: 10 * 60,
          endsAtMinutes: 11 * 60,
          amountMinor: String(PEAK_PRICE_MINOR),
          currency: 'COP',
          priority: 10,
        }),
      );
      peakRuleId = (response.body.rules[0] as PriceRuleBody).id;

      const persisted = await prisma.priceRule.findMany({
        where: { spaceId: spaceE1 },
        select: { id: true, amountMinor: true },
      });
      expect(persisted).toEqual([
        { id: peakRuleId, amountMinor: BigInt(PEAK_PRICE_MINOR) },
      ]);
    });

    it('rechaza cruces ambiguos de la misma prioridad y día', async () => {
      const overlap = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({
          rules: [
            peakRule(),
            peakRule({ startsAtMinutes: 10 * 60 + 30, endsAtMinutes: 11 * 60 + 30 }),
          ],
        })
        .expect(400);

      expectProblem(overlap, 400, 'VALIDATION_ERROR');
      expect(overlap.body.message).toContain('10:00-11:00');
      expect(overlap.body.message).toContain('10:30-11:30');
      expect(overlap.body.details).toEqual([
        expect.objectContaining({
          field: 'rules[1]',
          constraints: ['ambiguousOverlap'],
          indexes: [0, 1],
        }),
      ]);

      // dayOfWeek nulo es comodín: también choca con una regla de un día.
      const wildcard = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({
          rules: [
            peakRule({ dayOfWeek: null, priority: 0 }),
            peakRule({ priority: 0 }),
          ],
        })
        .expect(400);
      expectProblem(wildcard, 400, 'VALIDATION_ERROR');
      expect(wildcard.body.details).toEqual([
        expect.objectContaining({ constraints: ['ambiguousOverlap'] }),
      ]);

      // Ningún PUT rechazado modificó la grilla guardada.
      const persisted = await prisma.priceRule.count({ where: { spaceId: spaceE1 } });
      expect(persisted).toBe(1);
    });

    it('valida moneda, rango, importe, día y tamaño máximo', async () => {
      const currency = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule({ currency: 'USD' })] })
        .expect(400);
      expectProblem(currency, 400, 'VALIDATION_ERROR');
      expect(currency.body.details).toEqual([
        { field: 'rules[0].currency', constraints: ['matchesCurrency'] },
      ]);

      const inverted = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule({ startsAtMinutes: 12 * 60, endsAtMinutes: 11 * 60 })] })
        .expect(400);
      expectProblem(inverted, 400, 'VALIDATION_ERROR');
      expect(inverted.body.details).toEqual([
        expect.objectContaining({ field: 'rules[0]', constraints: ['range'] }),
      ]);

      const zeroAmount = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule({ amountMinor: 0 })] })
        .expect(400);
      expectProblem(zeroAmount, 400, 'VALIDATION_ERROR');
      expect(zeroAmount.body.details).toEqual([
        expect.objectContaining({ field: 'rules.0.amountMinor' }),
      ]);

      const invalidDay = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule({ dayOfWeek: 7 })] })
        .expect(400);
      expectProblem(invalidDay, 400, 'VALIDATION_ERROR');
      expect(invalidDay.body.details).toEqual([
        expect.objectContaining({ field: 'rules.0.dayOfWeek' }),
      ]);

      const tooMany = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({
          rules: Array.from({ length: 101 }, (_, index) => ({
            startsAtMinutes: index,
            endsAtMinutes: index + 1,
            amountMinor: 1_000,
          })),
        })
        .expect(400);
      expectProblem(tooMany, 400, 'VALIDATION_ERROR');
      expect(tooMany.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'rules' }),
        ]),
      );
    });

    it('el staff recibe 403 al escribir y la grilla no cambia', async () => {
      const denied = await auth(
        request(server()).put(priceRulesPath()),
        'staffE1',
      )
        .send({ rules: [peakRule({ amountMinor: 1 })] })
        .expect(403);
      expectProblem(denied, 403, 'PERMISSION_DENIED');

      const rules = await auth(
        request(server()).get(priceRulesPath()),
        'ownerE1',
      ).expect(200);
      expect(rules.body.rules).toHaveLength(1);
      expect(rules.body.rules[0]).toEqual(
        expect.objectContaining({
          id: peakRuleId,
          amountMinor: String(PEAK_PRICE_MINOR),
        }),
      );
    });

    it('aísla las canchas y las sedes en la lectura y la escritura', async () => {
      const otherSpaceRead = await auth(
        request(server()).get(priceRulesPath(e1, spaceE2)),
        'ownerE1',
      ).expect(404);
      expectProblem(otherSpaceRead, 404, 'SPACE_NOT_FOUND');

      const otherSpaceWrite = await auth(
        request(server()).put(priceRulesPath(e1, spaceE2)),
        'ownerE1',
      )
        .send({ rules: [] })
        .expect(404);
      expectProblem(otherSpaceWrite, 404, 'SPACE_NOT_FOUND');

      const otherTenant = await auth(
        request(server()).get(priceRulesPath(e2, spaceE2)),
        'ownerE1',
      ).expect(403);
      expectProblem(otherTenant, 403, 'TENANT_FORBIDDEN');

      const foreignOwner = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE2',
      )
        .send({ rules: [] })
        .expect(403);
      expectProblem(foreignOwner, 403, 'TENANT_FORBIDDEN');
    });
  });

  describe('Disponibilidad y reservas', () => {
    it('la disponibilidad pública usa el precio de la regla y la tarifa fija', async () => {
      const response = await publicAvailability();
      const slots = spaceSlots(response);

      expect(
        slots.map((slot) => ({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          priceMinor: slot.priceMinor,
          currency: slot.currency,
        })),
      ).toEqual([
        {
          ...slotAtMinutes(9 * 60),
          priceMinor: String(BASE_PRICE_MINOR),
          currency: 'COP',
        },
        {
          ...slotAtMinutes(10 * 60),
          priceMinor: String(PEAK_PRICE_MINOR),
          currency: 'COP',
        },
        {
          ...slotAtMinutes(11 * 60),
          priceMinor: String(BASE_PRICE_MINOR),
          currency: 'COP',
        },
      ]);

      const tenant = await auth(
        request(server()).get(
          `/api/v1/establishments/${e1}/spaces/${spaceE1}/availability?date=${date}`,
        ),
        'staffE1',
      ).expect(200);
      expect(
        (tenant.body.slots as Array<{ priceMinor: string }>).map(
          (slot) => slot.priceMinor,
        ),
      ).toEqual([
        String(BASE_PRICE_MINOR),
        String(PEAK_PRICE_MINOR),
        String(BASE_PRICE_MINOR),
      ]);
    });

    it('crear una reserva cobra el precio mostrado por el servidor', async () => {
      const availability = await publicAvailability();
      const peakSlot = spaceSlots(availability).find(
        (slot) => slot.startsAt === slotAtMinutes(10 * 60).startsAt,
      );
      expect(peakSlot).toBeDefined();
      expect(peakSlot?.priceMinor).toBe(String(PEAK_PRICE_MINOR));

      const ruleBooking = await auth(
        request(server())
          .post('/api/v1/bookings')
          .send({ spaceId: spaceE1, ...slotAtMinutes(10 * 60) }),
        'player',
      ).expect(201);
      bookingRuleId = ruleBooking.body.id as string;
      expect(ruleBooking.body).toEqual(
        expect.objectContaining({
          spaceId: spaceE1,
          totalMinor: peakSlot?.priceMinor,
          currency: 'COP',
          status: 'confirmed',
        }),
      );

      const baseSlot = spaceSlots(await publicAvailability()).find(
        (slot) => slot.startsAt === slotAtMinutes(9 * 60).startsAt,
      );
      expect(baseSlot?.priceMinor).toBe(String(BASE_PRICE_MINOR));

      const baseBooking = await auth(
        request(server())
          .post('/api/v1/bookings')
          .send({ spaceId: spaceE1, ...slotAtMinutes(9 * 60) }),
        'player',
      ).expect(201);
      bookingBaseId = baseBooking.body.id as string;
      expect(baseBooking.body.totalMinor).toBe(String(BASE_PRICE_MINOR));

      const rows = await prisma.booking.findMany({
        where: { id: { in: [bookingRuleId as string, bookingBaseId as string] } },
        select: { id: true, totalMinor: true, currency: true },
        orderBy: { startsAt: 'asc' },
      });
      expect(rows).toEqual([
        { id: bookingBaseId, totalMinor: BigInt(BASE_PRICE_MINOR), currency: 'COP' },
        { id: bookingRuleId, totalMinor: BigInt(PEAK_PRICE_MINOR), currency: 'COP' },
      ]);
    });

    it('cambiar las reglas no modifica las reservas existentes', async () => {
      const updated = await auth(
        request(server()).put(priceRulesPath()),
        'ownerE1',
      )
        .send({ rules: [peakRule({ amountMinor: UPDATED_PEAK_PRICE_MINOR })] })
        .expect(200);
      expect(updated.body.rules[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          amountMinor: String(UPDATED_PEAK_PRICE_MINOR),
        }),
      );

      const rows = await prisma.booking.findMany({
        where: { id: { in: [bookingRuleId as string, bookingBaseId as string] } },
        select: { id: true, totalMinor: true },
        orderBy: { startsAt: 'asc' },
      });
      expect(rows).toEqual([
        { id: bookingBaseId, totalMinor: BigInt(BASE_PRICE_MINOR) },
        { id: bookingRuleId, totalMinor: BigInt(PEAK_PRICE_MINOR) },
      ]);

      const mine = await auth(
        request(server()).get('/api/v1/me/bookings'),
        'player',
      ).expect(200);
      const mineById = new Map(
        (mine.body as Array<{ id: string; totalMinor: string }>).map(
          (booking) => [booking.id, booking.totalMinor],
        ),
      );
      expect(mineById.get(bookingBaseId as string)).toBe(String(BASE_PRICE_MINOR));
      expect(mineById.get(bookingRuleId as string)).toBe(String(PEAK_PRICE_MINOR));

      // La reserva conserva su importe; la nueva grilla aplica al resto.
      const availability = await publicAvailability();
      const remaining = spaceSlots(availability).find(
        (slot) => slot.startsAt === slotAtMinutes(11 * 60).startsAt,
      );
      expect(remaining?.priceMinor).toBe(String(BASE_PRICE_MINOR));
    });

    it('vaciar la grilla devuelve todas las franjas a la tarifa fija', async () => {
      await auth(request(server()).put(priceRulesPath()), 'ownerE1')
        .send({ rules: [] })
        .expect(200);

      const availability = await publicAvailability();
      const remaining = spaceSlots(availability).find(
        (slot) => slot.startsAt === slotAtMinutes(11 * 60).startsAt,
      );
      expect(remaining?.priceMinor).toBe(String(BASE_PRICE_MINOR));

      const rules = await auth(
        request(server()).get(priceRulesPath()),
        'ownerE1',
      ).expect(200);
      expect(rules.body).toEqual({ rules: [] });
    });
  });

  describe('Autorización', () => {
    it('un establecimiento inexistente responde 404', async () => {
      const response = await auth(
        request(server()).get(priceRulesPath(MISSING_ESTABLISHMENT, spaceE1)),
        'ownerE1',
      ).expect(404);
      expectProblem(response, 404, 'ESTABLISHMENT_NOT_FOUND');
    });

    it('un jugador sin membresía recibe 403 y un anónimo 401', async () => {
      const player = await auth(
        request(server()).get(priceRulesPath()),
        'player',
      ).expect(403);
      expectProblem(player, 403, 'TENANT_FORBIDDEN');

      const anon = await auth(
        request(server()).get(priceRulesPath()),
        'anon',
      ).expect(401);
      expectProblem(anon, 401, 'UNAUTHENTICATED');
    });
  });
});
