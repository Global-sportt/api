import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BookingStatus,
  GroupScope,
  SpaceStatus,
} from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
  type QueryPlan,
} from '../src/common/authz/authorization.types';
import { wallClockToUtc } from '../src/common/time/zoned-time';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120_000);

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'frase-segura-2026';
const TIMEZONE = 'America/Bogota';

interface TestUser {
  userId: string;
  email: string;
  token: string;
}

interface EstablishmentBody {
  id: string;
  name: string;
  slug: string;
}

interface Slot {
  startsAt: string;
  endsAt: string;
}

interface DayCloseBody {
  id: string;
  establishmentId: string;
  date: string;
  closedAt: string;
  closedByUserId: string;
  reopenedAt: string | null;
  reopenedByUserId: string | null;
  bookingsCount: number;
  noShowCount: number;
  cancelledCount: number;
  totalMinor: string;
  currency: string;
  spaceTotals: Array<{
    spaceId: string;
    bookingsCount: number;
    noShowCount: number;
    totalMinor: string;
  }>;
}

/**
 * PDP double for the default run. With `E2E_REAL_CERBOS=1` the real Cerbos
 * process at 127.0.0.1:3592 evaluates the same policies.
 */
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
      if (scope === 'own') {
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
      }
      return { kind: PLAN_KIND.ALWAYS_DENIED };
    },
  };
}

let app: INestApplication;
let prisma: PrismaService;
let ipCounter = 700;

function server() {
  return app.getHttpServer();
}

function nextIp(): string {
  ipCounter += 1;
  return `10.80.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function registerUser(label: string): Promise<TestUser> {
  const ip = nextIp();
  const email = `e2e-day-close-${label}-${Date.now()}-${ipCounter}@example.com`;

  const registered = await request(server())
    .post('/api/v1/auth/register')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ email, password: PASSWORD, displayName: label })
    .expect(201);

  const verificationToken = registered.body?.dev?.verificationToken as
    | string
    | undefined;
  expect(typeof verificationToken).toBe('string');

  await request(server())
    .post('/api/v1/auth/verify-email')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ token: verificationToken })
    .expect(200);

  return login(email);
}

async function login(email: string): Promise<TestUser> {
  const response = await request(server())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', nextIp())
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    userId: response.body.user.id as string,
    email,
    token: response.body.accessToken as string,
  };
}

async function assignPlatformAdmin(userId: string): Promise<void> {
  const group = await prisma.securityGroup.findFirst({
    where: { establishmentId: null, slug: 'platform-admin' },
    select: { id: true },
  });

  if (!group) {
    throw new Error('Falta el grupo global platform-admin; ejecuta el seed.');
  }

  await prisma.userGlobalGroup.create({
    data: { userId, groupId: group.id, groupScope: GroupScope.global },
  });
}

function bearer(builder: request.Test, token: string): request.Test {
  return builder.set('Authorization', `Bearer ${token}`).set('Origin', ORIGIN);
}

async function registerAdmin(): Promise<TestUser> {
  const admin = await registerUser('admin');
  await assignPlatformAdmin(admin.userId);
  return login(admin.email);
}

async function createEstablishment(
  adminToken: string,
  name: string,
  slug: string,
  ownerUserId: string,
): Promise<EstablishmentBody> {
  const response = await bearer(
    request(server())
      .post('/api/v1/admin/establishments')
      .send({
        name,
        slug,
        timezone: TIMEZONE,
        currency: 'COP',
        ownerUserId,
      }),
    adminToken,
  ).expect(201);

  return response.body as EstablishmentBody;
}

async function addStaff(
  ownerToken: string,
  establishmentId: string,
  userId: string,
): Promise<void> {
  await bearer(
    request(server())
      .post(`/api/v1/establishments/${establishmentId}/memberships`)
      .send({ userId, groupSlug: 'staff' }),
    ownerToken,
  ).expect(201);
}

async function createSpace(
  establishmentId: string,
  slug: string,
  name: string,
): Promise<string> {
  const space = await prisma.space.create({
    data: {
      establishmentId,
      name,
      slug,
      sport: 'futbol',
      slotMinutes: 60,
      bufferMinutes: 0,
      status: SpaceStatus.active,
      operatingHours: {
        create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAtMinutes: 8 * 60,
          closesAtMinutes: 20 * 60,
        })),
      },
      priceRules: {
        create: [
          {
            dayOfWeek: null,
            startsAtMinutes: 0,
            endsAtMinutes: 1440,
            amountMinor: 25_000n,
            currency: 'COP',
            priority: 0,
          },
        ],
      },
    },
    select: { id: true },
  });

  return space.id;
}

function localDate(offsetDays: number): string {
  const instant = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function slotAt(date: string, hour: number, duration = 60): Slot {
  return {
    startsAt: wallClockToUtc(date, hour * 60, TIMEZONE).instant.toISOString(),
    endsAt: wallClockToUtc(date, hour * 60 + duration, TIMEZONE).instant.toISOString(),
  };
}

function createOwnBooking(
  token: string,
  spaceId: string,
  slot: Slot,
): request.Test {
  return bearer(
    request(server()).post('/api/v1/bookings').send({ spaceId, ...slot }),
    token,
  );
}

function createTenantBooking(
  token: string,
  establishmentId: string,
  spaceId: string,
  playerId: string,
  slot: Slot,
): request.Test {
  return bearer(
    request(server())
      .post(`/api/v1/establishments/${establishmentId}/bookings`)
      .send({ spaceId, playerId, ...slot }),
    token,
  );
}

function closeDay(
  token: string,
  establishmentId: string,
  date: string,
): request.Test {
  return bearer(
    request(server())
      .post(`/api/v1/establishments/${establishmentId}/day-closes`)
      .send({ date }),
    token,
  );
}

function getDayClose(
  token: string,
  establishmentId: string,
  date: string,
): request.Test {
  return bearer(
    request(server()).get(
      `/api/v1/establishments/${establishmentId}/day-closes/${date}`,
    ),
    token,
  );
}

function listDayCloses(
  token: string,
  establishmentId: string,
  from: string,
  to: string,
): request.Test {
  return bearer(
    request(server())
      .get(`/api/v1/establishments/${establishmentId}/day-closes`)
      .query({ from, to }),
    token,
  );
}

function reopenDay(
  token: string,
  establishmentId: string,
  date: string,
): request.Test {
  return bearer(
    request(server()).post(
      `/api/v1/establishments/${establishmentId}/day-closes/${date}/reopen`,
    ),
    token,
  );
}

describe('Cierre diario: totales, consulta y bloqueo operativo (e2e)', () => {
  let admin: TestUser;
  let owner1: TestUser;
  let owner2: TestUser;
  let staff1: TestUser;
  let playerA: TestUser;
  let e1: EstablishmentBody;
  let e2: EstablishmentBody;
  let s1: string;
  let s2: string;

  const day = localDate(2);

  let b1: string;
  let b2: string;
  let b4: string;
  let b5: string;
  let b7: string;

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

    await prisma.booking.deleteMany();
    await prisma.establishment.deleteMany();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "auth_events", "oauth_states", "refresh_tokens", "sessions", "verification_tokens", "oauth_accounts", "profiles", "users" RESTART IDENTITY CASCADE',
    );

    admin = await registerAdmin();
    owner1 = await registerUser('owner1');
    owner2 = await registerUser('owner2');
    staff1 = await registerUser('staff1');
    playerA = await registerUser('playerA');

    e1 = await createEstablishment(
      admin.token,
      'E2E Cierre Norte',
      `e2e-day-close-norte-${Date.now()}`,
      owner1.userId,
    );
    e2 = await createEstablishment(
      admin.token,
      'E2E Cierre Sur',
      `e2e-day-close-sur-${Date.now()}`,
      owner2.userId,
    );

    await addStaff(owner1.token, e1.id, staff1.userId);

    s1 = await createSpace(e1.id, `dc-s1-${Date.now()}`, 'Cancha 1');
    s2 = await createSpace(e1.id, `dc-s2-${Date.now()}`, 'Cancha 2');

    // Foto esperada del día:
    // b1 confirmada, b2 completada, b4 no-show y b7 confirmada suman.
    // b5 cancelada y b6 pending_payment no suman.
    const createdB1 = await createOwnBooking(playerA.token, s1, slotAt(day, 9)).expect(201);
    b1 = createdB1.body.id as string;

    const createdB2 = await createOwnBooking(playerA.token, s1, slotAt(day, 10)).expect(201);
    b2 = createdB2.body.id as string;
    await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${b2}/status`)
        .send({ status: 'checked_in' }),
      staff1.token,
    ).expect(200);
    await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${b2}/status`)
        .send({ status: 'completed' }),
      staff1.token,
    ).expect(200);

    const createdB4 = await createOwnBooking(playerA.token, s2, slotAt(day, 11)).expect(201);
    b4 = createdB4.body.id as string;
    await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${b4}/status`)
        .send({ status: 'no_show' }),
      staff1.token,
    ).expect(200);

    const createdB5 = await createOwnBooking(playerA.token, s2, slotAt(day, 12)).expect(201);
    b5 = createdB5.body.id as string;
    await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${b5}/status`)
        .send({ status: 'cancelled' }),
      staff1.token,
    ).expect(200);

    const createdB7 = await createOwnBooking(playerA.token, s1, slotAt(day, 14)).expect(201);
    b7 = createdB7.body.id as string;

    // Hold que nunca debe entrar en la foto.
    await prisma.booking.create({
      data: {
        publicCode: `DC-${Date.now()}-HOLD`,
        establishmentId: e1.id,
        spaceId: s2,
        playerId: playerA.userId,
        createdByUserId: owner1.userId,
        startsAt: new Date(slotAt(day, 13).startsAt),
        endsAt: new Date(slotAt(day, 13).endsAt),
        status: BookingStatus.pending_payment,
        totalMinor: 25_000n,
        currency: 'COP',
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('cierra el día con reservas de varios espacios y congela los totales', async () => {
    const response = await closeDay(staff1.token, e1.id, day).expect(201);
    const body = response.body as DayCloseBody;

    expect(body.establishmentId).toBe(e1.id);
    expect(body.date).toBe(day);
    expect(body.closedByUserId).toBe(staff1.userId);
    expect(body.reopenedAt).toBeNull();
    expect(body.reopenedByUserId).toBeNull();
    expect(body.currency).toBe('COP');
    expect(body.bookingsCount).toBe(4);
    expect(body.noShowCount).toBe(1);
    expect(body.cancelledCount).toBe(1);
    expect(body.totalMinor).toBe('100000');
    expect(body.spaceTotals).toHaveLength(2);
    expect(body.spaceTotals).toEqual(
      expect.arrayContaining([
        { spaceId: s1, bookingsCount: 3, noShowCount: 0, totalMinor: '75000' },
        { spaceId: s2, bookingsCount: 1, noShowCount: 1, totalMinor: '25000' },
      ]),
    );
  });

  it('consulta el cierre por fecha y por rango', async () => {
    const detail = await getDayClose(staff1.token, e1.id, day).expect(200);
    expect((detail.body as DayCloseBody).totalMinor).toBe('100000');
    expect((detail.body as DayCloseBody).spaceTotals).toHaveLength(2);

    const list = await listDayCloses(staff1.token, e1.id, day, day).expect(200);
    expect(list.body as DayCloseBody[]).toHaveLength(1);
    expect((list.body as DayCloseBody[])[0]?.date).toBe(day);

    const tooWide = await listDayCloses(
      staff1.token,
      e1.id,
      shiftDate(day, -100),
      day,
    ).expect(400);
    expect(tooWide.body.code).toBe('VALIDATION_ERROR');
  });

  it('mantiene la foto congelada aunque cambien las reservas por SQL', async () => {
    // Evidence that the snapshot is persisted, not recomputed on read.
    await prisma.booking.update({
      where: { id: b1 },
      data: { totalMinor: 99_000n },
    });

    const detail = await getDayClose(owner1.token, e1.id, day).expect(200);
    expect((detail.body as DayCloseBody).totalMinor).toBe('100000');
    expect(
      (detail.body as DayCloseBody).spaceTotals.find(
        (total) => total.spaceId === s1,
      )?.totalMinor,
    ).toBe('75000');

    await prisma.booking.update({
      where: { id: b1 },
      data: { totalMinor: 25_000n },
    });
  });

  it('rechaza un doble cierre con 409 DAY_ALREADY_CLOSED', async () => {
    const response = await closeDay(owner1.token, e1.id, day).expect(409);
    expect(response.body.code).toBe('DAY_ALREADY_CLOSED');

    // El 409 no altera la foto.
    const detail = await getDayClose(owner1.token, e1.id, day).expect(200);
    expect((detail.body as DayCloseBody).bookingsCount).toBe(4);
  });

  it('bloquea crear, cambiar y cancelar reservas de un día cerrado con DAY_CLOSED', async () => {
    const createOwn = await createOwnBooking(
      playerA.token,
      s1,
      slotAt(day, 15),
    ).expect(409);
    expect(createOwn.body.code).toBe('DAY_CLOSED');

    const createTenant = await createTenantBooking(
      staff1.token,
      e1.id,
      s1,
      playerA.userId,
      slotAt(day, 16),
    ).expect(409);
    expect(createTenant.body.code).toBe('DAY_CLOSED');

    const changeStatus = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${b1}/status`)
        .send({ status: 'no_show' }),
      staff1.token,
    ).expect(409);
    expect(changeStatus.body.code).toBe('DAY_CLOSED');

    const cancel = await bearer(
      request(server()).post(`/api/v1/me/bookings/${b7}/cancel`),
      playerA.token,
    ).expect(409);
    expect(cancel.body.code).toBe('DAY_CLOSED');

    // Nada de lo bloqueado se persistió.
    const unchanged = await prisma.booking.findUnique({
      where: { id: b1 },
      select: { status: true },
    });
    expect(unchanged?.status).toBe(BookingStatus.confirmed);
    const stillConfirmed = await prisma.booking.findUnique({
      where: { id: b7 },
      select: { status: true },
    });
    expect(stillConfirmed?.status).toBe(BookingStatus.confirmed);
  });

  it('impide que staff reabra el día (solo dueño o plataforma)', async () => {
    const denied = await reopenDay(staff1.token, e1.id, day).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');

    const detail = await getDayClose(owner1.token, e1.id, day).expect(200);
    expect((detail.body as DayCloseBody).reopenedAt).toBeNull();
  });

  it('aísla la sede: otra sede no ve este cierre', async () => {
    // El dueño de E2 no tiene membresía en E1.
    const crossTenant = await getDayClose(owner2.token, e1.id, day).expect(403);
    expect(crossTenant.body.code).toBe('TENANT_FORBIDDEN');

    // Plataforma sí puede consultar E2, que nunca se cerró: 404.
    const missing = await getDayClose(admin.token, e2.id, day).expect(404);
    expect(missing.body.code).toBe('DAY_CLOSE_NOT_FOUND');
  });

  it('reabre el día por el dueño y vuelve a permitir operar', async () => {
    const reopened = await reopenDay(owner1.token, e1.id, day).expect(200);
    const body = reopened.body as DayCloseBody;
    expect(body.reopenedAt).not.toBeNull();
    expect(body.reopenedByUserId).toBe(owner1.userId);

    const again = await reopenDay(owner1.token, e1.id, day).expect(409);
    expect(again.body.code).toBe('DAY_ALREADY_REOPENED');

    const created = await createOwnBooking(
      playerA.token,
      s1,
      slotAt(day, 15),
    ).expect(201);
    expect(created.body.status).toBe(BookingStatus.confirmed);

    const cancelled = await bearer(
      request(server()).post(`/api/v1/me/bookings/${b7}/cancel`),
      playerA.token,
    ).expect(200);
    expect(cancelled.body.status).toBe(BookingStatus.cancelled);
  });

  it('vuelve a cerrar un día reabierto recalculando la foto', async () => {
    const response = await closeDay(owner1.token, e1.id, day).expect(200);
    const body = response.body as DayCloseBody;

    // Cambios posteriores a la reapertura: b7 cancelada (no suma) y la
    // reserva creada a las 15:00 suma.
    expect(body.closedByUserId).toBe(owner1.userId);
    expect(body.reopenedAt).toBeNull();
    expect(body.reopenedByUserId).toBeNull();
    expect(body.bookingsCount).toBe(4);
    expect(body.noShowCount).toBe(1);
    expect(body.cancelledCount).toBe(2);
    expect(body.totalMinor).toBe('100000');
    expect(body.spaceTotals).toHaveLength(2);
    expect(body.spaceTotals).toEqual(
      expect.arrayContaining([
        { spaceId: s1, bookingsCount: 3, noShowCount: 0, totalMinor: '75000' },
        { spaceId: s2, bookingsCount: 1, noShowCount: 1, totalMinor: '25000' },
      ]),
    );

    const blocked = await createOwnBooking(
      playerA.token,
      s2,
      slotAt(day, 17),
    ).expect(409);
    expect(blocked.body.code).toBe('DAY_CLOSED');
  });

  it('la base rechaza duplicados de cierre y de total por espacio', async () => {
    const close = await prisma.dayClose.findUniqueOrThrow({
      where: {
        establishmentId_date: {
          establishmentId: e1.id,
          date: new Date(`${day}T00:00:00.000Z`),
        },
      },
      select: { id: true, spaceTotals: { select: { spaceId: true } } },
    });

    await expect(
      prisma.dayClose.create({
        data: {
          establishmentId: e1.id,
          date: new Date(`${day}T00:00:00.000Z`),
          closedAt: new Date(),
          closedByUserId: owner1.userId,
          bookingsCount: 0,
          noShowCount: 0,
          cancelledCount: 0,
          totalMinor: 0n,
          currency: 'COP',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const spaceId = close.spaceTotals[0]?.spaceId as string;
    await expect(
      prisma.dayCloseSpaceTotal.create({
        data: {
          dayCloseId: close.id,
          spaceId,
          bookingsCount: 0,
          noShowCount: 0,
          totalMinor: 0n,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('valida el formato de fecha en el cuerpo y en el path', async () => {
    const badBody = await bearer(
      request(server())
        .post(`/api/v1/establishments/${e1.id}/day-closes`)
        .send({ date: '20/11/2026' }),
      owner1.token,
    ).expect(400);
    expect(badBody.body.code).toBe('VALIDATION_ERROR');

    const badPath = await getDayClose(owner1.token, e1.id, '2026-02-31').expect(
      400,
    );
    expect(badPath.body.code).toBe('VALIDATION_ERROR');
  });
});
