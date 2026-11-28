import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingStatus, EstablishmentStatus, GroupScope, SpaceStatus } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AppConfigService } from '../src/config/app-config.service';
import { AppLogger } from '../src/common/logging/app-logger.service';
import {
  AUTHORIZATION_SERVICE,
  PLAN_KIND,
  type AuthorizationService,
  type QueryPlan,
} from '../src/common/authz/authorization.types';
import { wallClockToUtc } from '../src/common/time/zoned-time';
import {
  MailerService,
  type BookingEmailDetails,
} from '../src/modules/auth/services/mailer.service';
import { BookingsExpiryService } from '../src/modules/bookings/bookings-expiry.service';
import { computeBookingRequestHash } from '../src/modules/bookings/booking-idempotency';
import { pgSqlState } from '../src/modules/bookings/booking-errors';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90_000);

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'frase-segura-2026';
const TIMEZONE = 'America/Bogota';
const MISSING_SPACE = '00000000-0000-4000-8000-000000000000';

interface TestUser {
  userId: string;
  email: string;
  token: string;
}

interface EstablishmentBody {
  id: string;
  name: string;
  slug: string;
  status: string;
}

interface BookingBody {
  id: string;
  publicCode: string;
  establishmentId: string;
  spaceId: string;
  playerId: string;
  createdByUserId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  totalMinor: string;
  currency: string;
  expiresAt: string | null;
}

interface Slot {
  startsAt: string;
  endsAt: string;
}

interface AvailabilityBody {
  spaces: Array<{
    id: string;
    slots: Array<Slot & { priceMinor: string; currency: string }>;
  }>;
}

/**
 * Default-run PDP double. It mirrors the booking policy scopes so the suite
 * also exercises list filters without the external process; the Gate 2 run
 * uses the real Cerbos PDP with E2E_REAL_CERBOS=1.
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

interface SentBookingEmail {
  kind: 'created' | 'cancelled';
  to: string;
  details: BookingEmailDetails;
}

/** Records booking emails so the suite can assert delivery without SMTP. */
const sentBookingEmails: SentBookingEmail[] = [];
let failNextBookingEmail = false;

const mailerDouble = {
  async sendVerificationEmail(): Promise<void> {},
  async sendPasswordResetEmail(): Promise<void> {},
  async sendBookingCreatedEmail(
    to: string,
    details: BookingEmailDetails,
  ): Promise<void> {
    if (failNextBookingEmail) {
      failNextBookingEmail = false;
      throw new Error('SMTP no disponible');
    }
    sentBookingEmails.push({ kind: 'created', to, details });
  },
  async sendBookingCancelledEmail(
    to: string,
    details: BookingEmailDetails,
  ): Promise<void> {
    sentBookingEmails.push({ kind: 'cancelled', to, details });
  },
};

async function waitForEmail(
  predicate: (email: SentBookingEmail) => boolean,
): Promise<SentBookingEmail> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    const match = sentBookingEmails.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error('Timeout esperando el correo de la reserva');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Notifications are fire-and-forget: give them a bounded window. */
async function settleNotifications(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

let app: INestApplication;
let prisma: PrismaService;
let ipCounter = 500;

function server() {
  return app.getHttpServer();
}

function nextIp(): string {
  ipCounter += 1;
  return `10.60.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function registerUser(label: string): Promise<TestUser> {
  const ip = nextIp();
  const email = `e2e-booking-${label}-${Date.now()}-${ipCounter}@example.com`;

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

  const loggedIn = await request(server())
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', nextIp())
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    userId: loggedIn.body.user.id as string,
    email,
    token: loggedIn.body.accessToken as string,
  };
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
    data: {
      userId,
      groupId: group.id,
      groupScope: GroupScope.global,
    },
  });
}

function bearer(requestBuilder: request.Test, token: string): request.Test {
  return requestBuilder
    .set('Authorization', `Bearer ${token}`)
    .set('Origin', ORIGIN);
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

function slotAtMinutes(date: string, startsAtMinutes: number, duration = 60): Slot {
  return {
    startsAt: wallClockToUtc(date, startsAtMinutes, TIMEZONE).instant.toISOString(),
    endsAt: wallClockToUtc(
      date,
      startsAtMinutes + duration,
      TIMEZONE,
    ).instant.toISOString(),
  };
}

function slotAt(date: string, hour: number): Slot {
  return slotAtMinutes(date, hour * 60);
}

function createOwnBooking(
  token: string,
  spaceId: string,
  slot: Slot,
  idempotencyKey?: string,
): request.Test {
  const builder = request(server())
    .post('/api/v1/bookings')
    .set('Authorization', `Bearer ${token}`)
    .set('Origin', ORIGIN)
    .send({ spaceId, ...slot });

  if (idempotencyKey) {
    builder.set('Idempotency-Key', idempotencyKey);
  }

  return builder;
}

function createTenantBooking(
  token: string,
  establishmentId: string,
  spaceId: string,
  playerId: string,
  slot: Slot,
): request.Test {
  return request(server())
    .post(`/api/v1/establishments/${establishmentId}/bookings`)
    .set('Authorization', `Bearer ${token}`)
    .set('Origin', ORIGIN)
    .send({ spaceId, playerId, ...slot });
}

async function publicAvailability(
  slug: string,
  date: string,
): Promise<AvailabilityBody> {
  const response = await request(server())
    .get(`/api/v1/public/establishments/${slug}/availability`)
    .query({ date })
    .expect(200);
  return response.body as AvailabilityBody;
}

function slotOf(
  availability: AvailabilityBody,
  spaceId: string,
  startsAt: string,
): (Slot & { priceMinor: string; currency: string }) | undefined {
  return availability.spaces
    .find((space) => space.id === spaceId)
    ?.slots.find((slot) => slot.startsAt === startsAt);
}

describe('Reservas: concurrencia, idempotencia y expiración (e2e)', () => {
  let admin: TestUser;
  let owner1: TestUser;
  let owner2: TestUser;
  let staff1: TestUser;
  let playerA: TestUser;
  let playerB: TestUser;
  let e1: EstablishmentBody;
  let e2: EstablishmentBody;
  let e3: EstablishmentBody;
  let s1: string;
  let s2: string;
  let s3: string;
  let s4: string;
  let inactiveSpace: string;

  const day1 = localDate(1);
  const day2 = localDate(2);
  const day3 = localDate(3);
  const day4 = localDate(4);
  const day5 = localDate(5);
  const pastDay = localDate(-1);

  beforeAll(async () => {
    const builder = Test.createTestingModule({ imports: [AppModule] });

    if (process.env.E2E_REAL_CERBOS !== '1') {
      builder
        .overrideProvider(AUTHORIZATION_SERVICE)
        .useValue(scopedPdp());
    }

    // Booking emails are asserted through a recording double; no SMTP needed.
    builder.overrideProvider(MailerService).useValue(mailerDouble);
    sentBookingEmails.length = 0;
    failNextBookingEmail = false;

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
    playerB = await registerUser('playerB');

    e1 = await createEstablishment(
      admin.token,
      'E2E Booking Norte',
      `e2e-booking-norte-${Date.now()}`,
      owner1.userId,
    );
    e2 = await createEstablishment(
      admin.token,
      'E2E Booking Sur',
      `e2e-booking-sur-${Date.now()}`,
      owner2.userId,
    );
    e3 = await createEstablishment(
      admin.token,
      'E2E Booking Estado',
      `e2e-booking-estado-${Date.now()}`,
      owner1.userId,
    );

    await addStaff(owner1.token, e1.id, staff1.userId);

    s1 = await createSpace(e1.id, `s1-${Date.now()}`, 'Cancha 1');
    s2 = await createSpace(e2.id, `s2-${Date.now()}`, 'Cancha Sur');
    s3 = await createSpace(e1.id, `s3-${Date.now()}`, 'Cancha 3');
    s4 = await createSpace(e3.id, `s4-${Date.now()}`, 'Cancha Estado');

    const inactive = await prisma.space.create({
      data: {
        establishmentId: e1.id,
        name: 'Cancha inactiva',
        slug: `s4-${Date.now()}`,
        status: SpaceStatus.inactive,
      },
      select: { id: true },
    });
    inactiveSpace = inactive.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('un jugador crea una reserva propia con precio y divisa del servidor', async () => {
    const slot = slotAt(day1, 9);
    const response = await createOwnBooking(playerA.token, s1, slot).expect(201);

    expect(response.body).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        publicCode: expect.stringMatching(/^BK[0-9A-F]{20}$/),
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        createdByUserId: playerA.userId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: BookingStatus.confirmed,
        totalMinor: '25000',
        currency: 'COP',
        expiresAt: null,
      }),
    );

    const row = await prisma.booking.findUnique({
      where: { id: response.body.id as string },
    });
    expect(row?.totalMinor).toBe(25_000n);
    expect(row?.requestHash).toBeNull();
  });

  it('rechaza slots no generados, espacios inexistentes/inactivos y campos de precio', async () => {
    const invalidSlot = await createOwnBooking(
      playerA.token,
      s1,
      slotAtMinutes(day1, 9 * 60 + 30),
    ).expect(400);
    expect(invalidSlot.body.code).toBe('VALIDATION_ERROR');

    const missing = await createOwnBooking(playerA.token, MISSING_SPACE, slotAt(day1, 10)).expect(404);
    expect(missing.body.code).toBe('SPACE_NOT_FOUND');

    const inactive = await createOwnBooking(playerA.token, inactiveSpace, slotAt(day1, 10)).expect(404);
    expect(inactive.body.code).toBe('SPACE_NOT_FOUND');

    const forgedPrice = await bearer(
      request(server())
        .post('/api/v1/bookings')
        .send({ spaceId: s1, ...slotAt(day1, 10), totalMinor: '1' }),
      playerA.token,
    ).expect(400);
    expect(forgedPrice.body.code).toBe('VALIDATION_ERROR');
  });

  it('F-01: rechaza reservas pasadas propias y tenant con 400 VALIDATION_ERROR', async () => {
    const own = await createOwnBooking(
      playerA.token,
      s1,
      slotAt(pastDay, 10),
    ).expect(400);
    expect(own.body.code).toBe('VALIDATION_ERROR');
    expect(own.body.details).toEqual([
      { field: 'startsAt', constraints: ['isFuture'] },
    ]);

    const tenant = await createTenantBooking(
      staff1.token,
      e1.id,
      s1,
      playerB.userId,
      slotAt(pastDay, 11),
    ).expect(400);
    expect(tenant.body.code).toBe('VALIDATION_ERROR');
    expect(tenant.body.details).toEqual([
      { field: 'startsAt', constraints: ['isFuture'] },
    ]);

    expect(
      await prisma.booking.count({
        where: {
          spaceId: s1,
          startsAt: {
            gte: new Date(slotAt(pastDay, 0).startsAt),
            lt: new Date(slotAt(pastDay, 23).endsAt),
          },
        },
      }),
    ).toBe(0);
  });

  it('F-02: rechaza reservas propias y tenant en sedes pending/suspended', async () => {
    // Baseline: the same establishment accepts a booking while active.
    const activeBooking = await createOwnBooking(
      playerA.token,
      s4,
      slotAt(day3, 15),
    ).expect(201);
    expect(activeBooking.body.establishmentId).toBe(e3.id);

    await prisma.establishment.update({
      where: { id: e3.id },
      data: { status: EstablishmentStatus.suspended },
    });

    const ownSuspended = await createOwnBooking(
      playerA.token,
      s4,
      slotAt(day3, 16),
    ).expect(404);
    expect(ownSuspended.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

    const tenantSuspended = await createTenantBooking(
      owner1.token,
      e3.id,
      s4,
      playerB.userId,
      slotAt(day3, 17),
    ).expect(404);
    expect(tenantSuspended.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

    await prisma.establishment.update({
      where: { id: e3.id },
      data: { status: EstablishmentStatus.pending },
    });

    const ownPending = await createOwnBooking(
      playerA.token,
      s4,
      slotAt(day3, 18),
    ).expect(404);
    expect(ownPending.body.code).toBe('ESTABLISHMENT_NOT_FOUND');

    // Only the baseline booking exists: the rejected attempts never inserted.
    expect(
      await prisma.booking.count({ where: { establishmentId: e3.id } }),
    ).toBe(1);
  });

  it('aísla /me por jugador: B no ve ni lee ni cancela la reserva de A', async () => {
    const ownA = await prisma.booking.findFirstOrThrow({
      where: { spaceId: s1, playerId: playerA.userId, startsAt: new Date(slotAt(day1, 9).startsAt) },
      select: { id: true },
    });

    const bookingB = await createOwnBooking(playerB.token, s1, slotAt(day1, 12)).expect(201);
    const bookingBId = bookingB.body.id as string;

    const listA = await bearer(
      request(server()).get('/api/v1/me/bookings'),
      playerA.token,
    ).expect(200);
    const idsA = (listA.body as BookingBody[]).map((booking) => booking.id);
    expect(idsA).toContain(ownA.id);
    expect(idsA).not.toContain(bookingBId);
    expect((listA.body as BookingBody[]).every((booking) => booking.playerId === playerA.userId)).toBe(true);

    const filtered = await bearer(
      request(server()).get('/api/v1/me/bookings').query({ status: 'confirmed' }),
      playerA.token,
    ).expect(200);
    expect((filtered.body as BookingBody[]).every((booking) => booking.status === 'confirmed')).toBe(true);

    // A playerId filter is accepted but only narrows: asking for B yields an
    // empty list, never B's booking.
    const filteredByOther = await bearer(
      request(server()).get('/api/v1/me/bookings').query({ playerId: playerB.userId }),
      playerA.token,
    ).expect(200);
    expect(filteredByOther.body).toEqual([]);

    const readForeign = await bearer(
      request(server()).get(`/api/v1/me/bookings/${bookingBId}`),
      playerA.token,
    ).expect(404);
    expect(readForeign.body.code).toBe('BOOKING_NOT_FOUND');

    const cancelForeign = await bearer(
      request(server()).post(`/api/v1/me/bookings/${bookingBId}/cancel`),
      playerA.token,
    ).expect(404);
    expect(cancelForeign.body.code).toBe('BOOKING_NOT_FOUND');

    const unchanged = await prisma.booking.findUnique({ where: { id: bookingBId } });
    expect(unchanged?.status).toBe(BookingStatus.confirmed);

    await bearer(
      request(server()).get(`/api/v1/me/bookings/${bookingBId}`),
      playerB.token,
    ).expect(200);
  });

  it('F-06: /me detail y cancelación autorizan sobre la reserva real (reserva ajena 404)', async () => {
    const created = await createOwnBooking(
      playerB.token,
      s1,
      slotAt(day3, 12),
    ).expect(201);
    const bookingId = created.body.id as string;

    const authorization = app.get<AuthorizationService>(AUTHORIZATION_SERVICE);
    const canSpy = jest.spyOn(authorization, 'can');
    // A2b added `decide()` so the guard can correlate cerbosCallId; when the
    // real service exposes it, the guard uses it instead of `can`.
    const decideSpy = jest.spyOn(
      authorization as unknown as {
        decide: (...args: unknown[]) => Promise<unknown>;
      },
      'decide',
    );

    try {
      const readForeign = await bearer(
        request(server()).get(`/api/v1/me/bookings/${bookingId}`),
        playerA.token,
      ).expect(404);
      expect(readForeign.body.code).toBe('BOOKING_NOT_FOUND');

      const cancelForeign = await bearer(
        request(server()).post(`/api/v1/me/bookings/${bookingId}/cancel`),
        playerA.token,
      ).expect(404);
      expect(cancelForeign.body.code).toBe('BOOKING_NOT_FOUND');

      const unchanged = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(unchanged?.status).toBe(BookingStatus.confirmed);

      // The service-level check must use the real booking owner, not the
      // synthetic playerId the guard injects for `/me`.
      const realCalls = canSpy.mock.calls.filter(([, , , resource]) => {
        return (
          resource?.id === bookingId &&
          resource?.playerId === playerB.userId
        );
      });
      const readCallIndex = canSpy.mock.calls.findIndex(
        ([, , action, resource]) =>
          action === 'read' &&
          resource?.id === bookingId &&
          resource?.playerId === playerB.userId,
      );
      expect(readCallIndex).toBeGreaterThanOrEqual(0);
      expect(await canSpy.mock.results[readCallIndex].value).toBe(false);

      expect(realCalls.find(([, , action]) => action === 'read')?.[3]).toEqual(
        expect.objectContaining({
          id: bookingId,
          playerId: playerB.userId,
          establishmentId: e1.id,
          status: BookingStatus.confirmed,
          startsAt: created.body.startsAt,
          endsAt: created.body.endsAt,
        }),
      );

      const cancelCallIndex = canSpy.mock.calls.findIndex(
        ([, , action, resource]) =>
          action === 'cancel' &&
          resource?.id === bookingId &&
          resource?.playerId === playerB.userId,
      );
      expect(cancelCallIndex).toBeGreaterThanOrEqual(0);
      expect(await canSpy.mock.results[cancelCallIndex].value).toBe(false);
      expect(
        realCalls.find(([, , action]) => action === 'cancel')?.[3],
      ).toEqual(
        expect.objectContaining({
          id: bookingId,
          playerId: playerB.userId,
          establishmentId: e1.id,
          status: BookingStatus.confirmed,
        }),
      );

      // The guard still evaluated its own (synthetic) resource before the
      // service re-evaluated the real one: both layers ran. The guard uses
      // decide() when available; can() remains the service-level call.
      const guardCalls = decideSpy.mock.calls.filter((args) => {
        const resource = args[3] as
          | { id?: string; playerId?: string }
          | undefined;
        return (
          resource?.id === bookingId &&
          resource?.playerId === playerA.userId
        );
      });
      expect(guardCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      canSpy.mockRestore();
      decideSpy.mockRestore();
    }
  });

  it('BKG-05: staff/owner de E1 opera en E1; owner de E2 recibe 403 T y el espacio cruzado 404', async () => {
    const created = await createTenantBooking(
      staff1.token,
      e1.id,
      s1,
      playerA.userId,
      slotAt(day1, 13),
    ).expect(201);
    expect(created.body).toEqual(
      expect.objectContaining({
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        createdByUserId: staff1.userId,
        totalMinor: '25000',
      }),
    );

    const e1List = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}/bookings`),
      staff1.token,
    ).expect(200);
    expect((e1List.body as BookingBody[]).every((booking) => booking.establishmentId === e1.id)).toBe(true);
    expect((e1List.body as BookingBody[]).length).toBeGreaterThanOrEqual(3);

    const owner2List = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}/bookings`),
      owner2.token,
    ).expect(403);
    expect(owner2List.body.code).toBe('TENANT_FORBIDDEN');

    const owner2Create = await createTenantBooking(
      owner2.token,
      e1.id,
      s1,
      playerB.userId,
      slotAt(day1, 15),
    ).expect(403);
    expect(owner2Create.body.code).toBe('TENANT_FORBIDDEN');

    const owner2Patch = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${created.body.id as string}/status`)
        .send({ status: 'checked_in' }),
      owner2.token,
    ).expect(403);
    expect(owner2Patch.body.code).toBe('TENANT_FORBIDDEN');

    const staffInE2 = await bearer(
      request(server()).get(`/api/v1/establishments/${e2.id}/bookings`),
      staff1.token,
    ).expect(403);
    expect(staffInE2.body.code).toBe('TENANT_FORBIDDEN');

    // Tenant creation in E2 works for its owner; the E1 list must not leak it.
    const e2Booking = await createTenantBooking(
      owner2.token,
      e2.id,
      s2,
      playerB.userId,
      slotAt(day1, 16),
    ).expect(201);

    const e1ListAdmin = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}/bookings`),
      admin.token,
    ).expect(200);
    const e1AdminIds = (e1ListAdmin.body as BookingBody[]).map((booking) => booking.id);
    expect(e1AdminIds).not.toContain(e2Booking.body.id as string);

    const adminCreate = await createTenantBooking(
      admin.token,
      e1.id,
      s1,
      playerB.userId,
      slotAt(day1, 14),
    ).expect(201);
    expect(adminCreate.body.establishmentId).toBe(e1.id);

    const crossTenant = await createTenantBooking(
      owner1.token,
      e1.id,
      s2,
      playerA.userId,
      slotAt(day1, 15),
    ).expect(404);
    expect(crossTenant.body.code).toBe('SPACE_NOT_FOUND');

    // BKG-05 database backstop: E1 + S2 violates the composite space FK.
    const badId = randomUUID();
    let dbError: unknown;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "bookings" (
          "id", "public_code", "establishment_id", "space_id", "player_id",
          "created_by_user_id", "starts_at", "ends_at", "status", "total_minor",
          "currency", "created_at", "updated_at"
        ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                  $7::timestamptz, $8::timestamptz, 'confirmed', 0, 'COP', NOW(), NOW())`,
        badId,
        `BKDIRECT${Date.now()}`,
        e1.id,
        s2,
        playerA.userId,
        owner1.userId,
        slotAt(day1, 17).startsAt,
        slotAt(day1, 17).endsAt,
      );
    } catch (error) {
      dbError = error;
    }

    expect(pgSqlState(dbError)).toBe('23503');
    expect(await prisma.booking.count({ where: { id: badId } })).toBe(0);
  });

  it('BKG-01: 20 POST concurrentes al mismo espacio/tiempo producen exactamente una reserva', async () => {
    const slot = slotAt(day1, 18);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        createOwnBooking(playerA.token, s1, slot),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    expect(statuses.filter((status) => status === 500)).toHaveLength(0);

    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(response.body.code).toBe('SLOT_TAKEN');
      expect(Array.isArray(response.body.details?.alternatives)).toBe(true);
      expect(response.body.details.alternatives.length).toBeLessThanOrEqual(3);
    }

    const active = await prisma.booking.count({
      where: {
        spaceId: s1,
        status: {
          in: [
            BookingStatus.pending_payment,
            BookingStatus.confirmed,
            BookingStatus.checked_in,
          ],
        },
        startsAt: { lt: new Date(slot.endsAt) },
        endsAt: { gt: new Date(slot.startsAt) },
      },
    });
    expect(active).toBe(1);
  });

  it('BKG-02/BKG-03: idempotencia por actor, replay 200, hash distinto 409 y terminal 409', async () => {
    const slot = slotAt(day2, 10);
    const key = `K-A-${Date.now()}`;

    const first = await createOwnBooking(playerA.token, s1, slot, key).expect(201);
    const bookingId = first.body.id as string;

    const replay = await createOwnBooking(playerA.token, s1, slot, key).expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(bookingId);

    const reused = await createOwnBooking(playerA.token, s1, slotAt(day2, 11), key).expect(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const rowsForKey = await prisma.booking.findMany({
      where: { createdByUserId: playerA.userId, idempotencyKey: key },
    });
    expect(rowsForKey).toHaveLength(1);
    expect(rowsForKey[0].requestHash).toBe(
      computeBookingRequestHash({
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      }),
    );

    await bearer(
      request(server()).post(`/api/v1/me/bookings/${bookingId}/cancel`),
      playerA.token,
    ).expect(200);

    const terminalReplay = await createOwnBooking(playerA.token, s1, slot, key).expect(409);
    expect(terminalReplay.body.code).toBe('INVALID_STATE');

    // The same key by another actor is a new idempotency namespace. The slot
    // was freed by A's cancellation, so B can book the exact same range.
    const otherActor = await createOwnBooking(playerB.token, s1, slot, key).expect(201);
    expect(otherActor.body.id).not.toBe(bookingId);
    expect(
      await prisma.booking.count({
        where: { idempotencyKey: key },
      }),
    ).toBe(2);

    // Concurrent same key/hash: the unique idempotency key and the GiST
    // exclusion can both fire, but all five callers must converge on one row.
    const concurrentSlot = slotAt(day2, 14);
    const concurrentKey = `K-CONC-${Date.now()}`;
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        createOwnBooking(playerA.token, s1, concurrentSlot, concurrentKey),
      ),
    );

    expect(concurrent.filter((response) => response.status === 201)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status === 200)).toHaveLength(4);
    expect(new Set(concurrent.map((response) => response.body.id as string)).size).toBe(1);
    expect(
      await prisma.booking.count({
        where: { createdByUserId: playerA.userId, idempotencyKey: concurrentKey },
      }),
    ).toBe(1);
  });

  it('BKG-04: un hold pending_payment vencido se oculta por tiempo y el job lo libera', async () => {
    const slot = slotAt(day3, 10);
    const expiresAt = new Date(Date.now() - 60_000);

    const hold = await prisma.booking.create({
      data: {
        publicCode: `BKHOLD${Date.now()}`,
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        createdByUserId: playerA.userId,
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
        status: BookingStatus.pending_payment,
        totalMinor: 25_000n,
        currency: 'COP',
        // First an unexpired hold hides the slot.
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    const whileHeld = await publicAvailability(e1.slug, day3);
    expect(slotOf(whileHeld, s1, slot.startsAt)).toBeUndefined();

    // Availability applies expires_at by time: once expired, the slot is free
    // even though the row is still pending_payment until the job runs.
    await prisma.booking.update({
      where: { id: hold.id },
      data: { expiresAt },
    });

    const beforeJob = await publicAvailability(e1.slug, day3);
    expect(slotOf(beforeJob, s1, slot.startsAt)).toBeDefined();

    const expiry = app.get(BookingsExpiryService);
    const firstRun = await expiry.expireHolds();
    expect(firstRun).toBeGreaterThanOrEqual(1);

    const expired = await prisma.booking.findUnique({ where: { id: hold.id } });
    expect(expired?.status).toBe(BookingStatus.expired);

    // Confirmed bookings are untouched by the expiry job.
    const confirmed = await prisma.booking.findFirstOrThrow({
      where: {
        spaceId: s1,
        startsAt: new Date(slotAt(day1, 9).startsAt),
        status: BookingStatus.confirmed,
      },
    });
    expect(confirmed.status).toBe(BookingStatus.confirmed);

    await expect(expiry.expireHolds()).resolves.toBe(0);

    const replacement = await createOwnBooking(playerA.token, s1, slot).expect(201);
    const active = await prisma.booking.count({
      where: {
        spaceId: s1,
        status: {
          in: [
            BookingStatus.pending_payment,
            BookingStatus.confirmed,
            BookingStatus.checked_in,
          ],
        },
        startsAt: { lt: new Date(slot.endsAt) },
        endsAt: { gt: new Date(slot.startsAt) },
      },
    });
    expect(active).toBe(1);
    expect(replacement.body.id).not.toBe(hold.id);

    // A late confirmation of an expired hold never revives it.
    const lateSlot = slotAt(day3, 11);
    const lateHold = await prisma.booking.create({
      data: {
        publicCode: `BKLATE${Date.now()}`,
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        createdByUserId: playerA.userId,
        startsAt: new Date(lateSlot.startsAt),
        endsAt: new Date(lateSlot.endsAt),
        status: BookingStatus.pending_payment,
        totalMinor: 25_000n,
        currency: 'COP',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const lateConfirm = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${lateHold.id}/status`)
        .send({ status: 'confirmed' }),
      staff1.token,
    ).expect(409);
    expect(lateConfirm.body.code).toBe('BOOKING_EXPIRED');

    await expect(expiry.expireHolds()).resolves.toBe(1);
    expect(
      (await prisma.booking.findUnique({ where: { id: lateHold.id } }))?.status,
    ).toBe(BookingStatus.expired);
  });

  it('la disponibilidad pública y tenant excluye la franja reservada', async () => {
    const slot = slotAt(day4, 9);

    const before = await publicAvailability(e1.slug, day4);
    expect(slotOf(before, s3, slot.startsAt)).toEqual(
      expect.objectContaining({ priceMinor: '25000', currency: 'COP' }),
    );
    expect(slotOf(before, s3, slotAt(day4, 10).startsAt)).toBeDefined();

    await createOwnBooking(playerA.token, s3, slot).expect(201);

    const after = await publicAvailability(e1.slug, day4);
    expect(slotOf(after, s3, slot.startsAt)).toBeUndefined();
    expect(slotOf(after, s3, slotAt(day4, 10).startsAt)).toBeDefined();

    const tenant = await bearer(
      request(server())
        .get(`/api/v1/establishments/${e1.id}/spaces/${s3}/availability`)
        .query({ date: day4 }),
      staff1.token,
    ).expect(200);
    const tenantSlots = tenant.body.slots as Slot[];
    expect(tenantSlots.some((candidate) => candidate.startsAt === slot.startsAt)).toBe(false);
    expect(tenantSlots.some((candidate) => candidate.startsAt === slotAt(day4, 10).startsAt)).toBe(true);
  });

  it('BKG-06/BKG-07: franjas adyacentes, estado tenant, cancelación propia y ventana cerrada', async () => {
    // BKG-06: the adjacent [10:00,11:00) slot after [09:00,10:00) is free.
    const adjacent = await createOwnBooking(playerA.token, s1, slotAt(day1, 10)).expect(201);
    expect(adjacent.body.startsAt).toBe(slotAt(day1, 10).startsAt);

    const transitions = await createOwnBooking(playerA.token, s1, slotAt(day2, 12)).expect(201);
    const transitionsId = transitions.body.id as string;
    const logger = app.get(AppLogger);
    const info = jest.spyOn(logger.raw, 'info');

    const checkedIn = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${transitionsId}/status`)
        .send({ status: 'checked_in' }),
      staff1.token,
    ).expect(200);
    expect(checkedIn.body.status).toBe(BookingStatus.checked_in);

    const completed = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${transitionsId}/status`)
        .send({ status: 'completed' }),
      staff1.token,
    ).expect(200);
    expect(completed.body.status).toBe(BookingStatus.completed);

    const invalid = await bearer(
      request(server())
        .patch(`/api/v1/establishments/${e1.id}/bookings/${transitionsId}/status`)
        .send({ status: 'confirmed' }),
      staff1.token,
    ).expect(409);
    expect(invalid.body.code).toBe('INVALID_STATE');

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'booking.status_changed',
        actorId: staff1.userId,
        bookingId: transitionsId,
        establishmentId: e1.id,
        fromStatus: BookingStatus.confirmed,
        toStatus: BookingStatus.checked_in,
        decision: 'allow',
      }),
      'booking.status_changed',
    );
    info.mockRestore();

    const cancellable = await createOwnBooking(playerA.token, s1, slotAt(day2, 13)).expect(201);
    const cancelled = await bearer(
      request(server()).post(`/api/v1/me/bookings/${cancellable.body.id as string}/cancel`),
      playerA.token,
    ).expect(200);
    expect(cancelled.body.status).toBe(BookingStatus.cancelled);

    const secondCancel = await bearer(
      request(server()).post(`/api/v1/me/bookings/${cancellable.body.id as string}/cancel`),
      playerA.token,
    ).expect(409);
    expect(secondCancel.body.code).toBe('INVALID_STATE');

    // F-01: the public API must reject a past slot...
    const pastSlot = slotAt(pastDay, 10);
    const pastRejected = await createOwnBooking(
      playerA.token,
      s1,
      pastSlot,
    ).expect(400);
    expect(pastRejected.body.code).toBe('VALIDATION_ERROR');
    expect(pastRejected.body.details).toEqual([
      { field: 'startsAt', constraints: ['isFuture'] },
    ]);

    // ...so the cancellation-window scenario is seeded directly in the DB.
    const past = await prisma.booking.create({
      data: {
        publicCode: `BKPAST${Date.now()}`,
        establishmentId: e1.id,
        spaceId: s1,
        playerId: playerA.userId,
        createdByUserId: playerA.userId,
        startsAt: new Date(pastSlot.startsAt),
        endsAt: new Date(pastSlot.endsAt),
        status: BookingStatus.confirmed,
        totalMinor: 25_000n,
        currency: 'COP',
      },
    });
    const closed = await bearer(
      request(server()).post(`/api/v1/me/bookings/${past.id}/cancel`),
      playerA.token,
    ).expect(409);
    expect(closed.body.code).toBe('CANCELLATION_WINDOW_CLOSED');
  });

  it('platform-admin sigue limitado a sus propias reservas en /me', async () => {
    const own = await createOwnBooking(admin.token, s1, slotAt(day1, 19)).expect(201);
    const ownId = own.body.id as string;

    const list = await bearer(
      request(server()).get('/api/v1/me/bookings'),
      admin.token,
    ).expect(200);
    const rows = list.body as BookingBody[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((booking) => booking.playerId === admin.userId)).toBe(true);

    const foreign = await prisma.booking.findFirstOrThrow({
      where: { playerId: playerA.userId, spaceId: s1 },
      select: { id: true },
    });

    const foreignRead = await bearer(
      request(server()).get(`/api/v1/me/bookings/${foreign.id}`),
      admin.token,
    ).expect(404);
    expect(foreignRead.body.code).toBe('BOOKING_NOT_FOUND');

    const tenant = await bearer(
      request(server()).get(`/api/v1/establishments/${e1.id}/bookings`),
      admin.token,
    ).expect(200);
    const tenantIds = (tenant.body as BookingBody[]).map((booking) => booking.id);
    expect(tenantIds).toContain(foreign.id);
    expect(tenantIds).toContain(ownId);
  });

  describe('notificaciones de reserva', () => {
    function formatExpectedStart(startsAt: string): string {
      return new Intl.DateTimeFormat('es-CO', {
        timeZone: TIMEZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(startsAt));
    }

    it('una reserva propia nueva encola el correo de confirmación', async () => {
      const slot = slotAt(day5, 9);
      const created = await createOwnBooking(playerA.token, s1, slot).expect(201);
      const publicCode = created.body.publicCode as string;

      const email = await waitForEmail(
        (candidate) =>
          candidate.kind === 'created' &&
          candidate.details.publicCode === publicCode,
      );

      expect(email.to).toBe(playerA.email.toLowerCase());
      expect(email.details).toEqual({
        publicCode,
        establishmentName: 'E2E Booking Norte',
        spaceName: 'Cancha 1',
        startsAt: formatExpectedStart(slot.startsAt),
        amount: '$\u00a025.000',
        address: null,
        cancellationPolicy: null,
      });
      // Bogotá wall clock, not the UTC instant of the slot.
      expect(email.details.startsAt).toContain('09:00');
    });

    it('una reserva creada por el establecimiento notifica al jugador y su cancelación también', async () => {
      const slot = slotAt(day5, 10);
      const created = await createTenantBooking(
        staff1.token,
        e1.id,
        s1,
        playerB.userId,
        slot,
      ).expect(201);
      const bookingId = created.body.id as string;
      const publicCode = created.body.publicCode as string;

      const createdEmail = await waitForEmail(
        (candidate) =>
          candidate.kind === 'created' &&
          candidate.details.publicCode === publicCode,
      );
      expect(createdEmail.to).toBe(playerB.email.toLowerCase());

      const cancelled = await bearer(
        request(server())
          .patch(`/api/v1/establishments/${e1.id}/bookings/${bookingId}/status`)
          .send({ status: 'cancelled' }),
        staff1.token,
      ).expect(200);
      expect(cancelled.body.status).toBe(BookingStatus.cancelled);

      const cancelledEmail = await waitForEmail(
        (candidate) =>
          candidate.kind === 'cancelled' &&
          candidate.details.publicCode === publicCode,
      );
      expect(cancelledEmail.to).toBe(playerB.email.toLowerCase());
    });

    it('cancelar una reserva propia encola el correo de cancelación', async () => {
      const slot = slotAt(day5, 11);
      const created = await createOwnBooking(playerA.token, s1, slot).expect(201);
      const bookingId = created.body.id as string;
      const publicCode = created.body.publicCode as string;

      await waitForEmail(
        (candidate) =>
          candidate.kind === 'created' &&
          candidate.details.publicCode === publicCode,
      );

      await bearer(
        request(server()).post(`/api/v1/me/bookings/${bookingId}/cancel`),
        playerA.token,
      ).expect(200);

      const email = await waitForEmail(
        (candidate) =>
          candidate.kind === 'cancelled' &&
          candidate.details.publicCode === publicCode,
      );
      expect(email.to).toBe(playerA.email.toLowerCase());
    });

    it('el replay idempotente no envía un segundo correo', async () => {
      const slot = slotAt(day5, 12);
      const key = `K-NOTIF-${Date.now()}`;

      const first = await createOwnBooking(playerA.token, s1, slot, key).expect(201);
      const publicCode = first.body.publicCode as string;

      await waitForEmail(
        (candidate) =>
          candidate.kind === 'created' &&
          candidate.details.publicCode === publicCode,
      );
      const beforeReplay = sentBookingEmails.filter(
        (candidate) => candidate.details.publicCode === publicCode,
      ).length;
      expect(beforeReplay).toBe(1);

      const replay = await createOwnBooking(playerA.token, s1, slot, key).expect(200);
      expect(replay.body.id).toBe(first.body.id);

      await settleNotifications();
      expect(
        sentBookingEmails.filter(
          (candidate) => candidate.details.publicCode === publicCode,
        ),
      ).toHaveLength(beforeReplay);
    });

    it('un fallo del mailer se registra y no rompe la reserva', async () => {
      await settleNotifications();
      const logger = app.get(AppLogger);
      const errorSpy = jest.spyOn(logger.raw, 'error');

      try {
        failNextBookingEmail = true;
        const created = await createOwnBooking(
          playerA.token,
          s1,
          slotAt(day5, 13),
        ).expect(201);
        const bookingId = created.body.id as string;
        const publicCode = created.body.publicCode as string;

        const deadline = Date.now() + 5_000;
        let failure: unknown;
        while (Date.now() < deadline && !failure) {
          failure = errorSpy.mock.calls.find(([entry]) => {
            const candidate = entry as { event?: string; bookingId?: string };
            return (
              candidate.event === 'booking_notification_failed' &&
              candidate.bookingId === bookingId
            );
          });
          if (!failure) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }

        expect(failure).toEqual([
          expect.objectContaining({
            event: 'booking_notification_failed',
            bookingId,
            notification: 'created',
            errorName: 'Error',
          }),
          'booking_notification_failed',
        ]);

        const stored = await prisma.booking.findUnique({
          where: { id: bookingId },
        });
        expect(stored?.status).toBe(BookingStatus.confirmed);
        expect(stored?.publicCode).toBe(publicCode);
        expect(
          sentBookingEmails.some(
            (candidate) => candidate.details.publicCode === publicCode,
          ),
        ).toBe(false);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
