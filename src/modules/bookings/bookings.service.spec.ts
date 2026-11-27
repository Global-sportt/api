import {
  BookingStatus,
  EstablishmentStatus,
  SpaceStatus,
  UserStatus,
} from '@prisma/client';

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
import type {
  AuthorizationService,
  AuthorizedPrincipal,
  PermissionResolver,
} from '../../common/authz/authorization.types';
import { AppError } from '../../common/errors/app-error';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SlotsService } from '../spaces/slots.service';
import type { BookingNotificationsService } from './booking-notifications.service';
import {
  BOOKING_START_TOLERANCE_MS,
  BookingsService,
  assertStartsAtNotInPast,
} from './bookings.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ESTABLISHMENT_ID = '33333333-3333-4333-8333-333333333333';
const SPACE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';

const playerPrincipal: AuthorizedPrincipal = {
  userId: USER_ID,
  permissions: {
    'booking:read': 'own',
    'booking:create': 'own',
    'booking:cancel': 'own',
  },
  isPlatformAdmin: false,
};

const platformPrincipal: AuthorizedPrincipal = {
  userId: USER_ID,
  permissions: {
    'booking:read': 'platform',
    'booking:create': 'platform',
    'booking:cancel': 'platform',
  },
  isPlatformAdmin: true,
};

interface PrismaMock {
  space: { findUnique: jest.Mock; findFirst: jest.Mock };
  user: { findUnique: jest.Mock };
  booking: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  scheduleException: { findFirst: jest.Mock };
  $transaction: jest.Mock;
}

interface ServiceMocks {
  service: BookingsService;
  prisma: PrismaMock;
  slots: { generate: jest.Mock };
  permissions: { resolve: jest.Mock };
  authorization: { can: jest.Mock; plan: jest.Mock };
  notifications: { notifyCreated: jest.Mock; notifyCancelled: jest.Mock };
}

function buildService(): ServiceMocks {
  const prisma: PrismaMock = {
    space: { findUnique: jest.fn(), findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    scheduleException: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };
  const slots = { generate: jest.fn() };
  const permissions = { resolve: jest.fn() };
  const authorization = { can: jest.fn(), plan: jest.fn() };
  const logger = { raw: { info: jest.fn() }, error: jest.fn() };
  const notifications = {
    notifyCreated: jest.fn().mockResolvedValue(undefined),
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new BookingsService(
      prisma as unknown as PrismaService,
      slots as unknown as SlotsService,
      permissions as unknown as PermissionResolver,
      authorization as unknown as AuthorizationService,
      logger as unknown as AppLogger,
      notifications as unknown as BookingNotificationsService,
    ),
    prisma,
    slots,
    permissions,
    authorization,
    notifications,
  };
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

function bookableSpace(
  establishmentStatus: EstablishmentStatus,
): Record<string, unknown> {
  return {
    id: SPACE_ID,
    establishmentId: ESTABLISHMENT_ID,
    slotMinutes: 60,
    bufferMinutes: 0,
    status: SpaceStatus.active,
    establishment: {
      timezone: 'America/Bogota',
      currency: 'COP',
      status: establishmentStatus,
    },
    operatingHours: [],
    priceRules: [],
  };
}

function bookingRow(overrides: Record<string, unknown> = {}) {
  const startsAt = new Date(Date.now() + 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);

  return {
    id: BOOKING_ID,
    publicCode: 'BK0123456789ABCDEF0123',
    establishmentId: ESTABLISHMENT_ID,
    spaceId: SPACE_ID,
    playerId: USER_ID,
    createdByUserId: USER_ID,
    startsAt,
    endsAt,
    status: BookingStatus.confirmed,
    totalMinor: 25_000n,
    currency: 'COP',
    idempotencyKey: null,
    requestHash: null,
    expiresAt: null,
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    updatedAt: new Date('2026-11-01T12:00:00.000Z'),
    ...overrides,
  };
}

function futureRequest() {
  const startsAt = new Date(Date.now() + 60 * 60_000);
  return {
    spaceId: SPACE_ID,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
  };
}

describe('BookingsService — F-01/F-02/F-06 hardening', () => {
  describe('F-01: start in the past', () => {
    it('allows the 30-second clock tolerance but rejects anything older', () => {
      const now = new Date('2026-11-26T12:00:00.000Z');

      expect(() =>
        assertStartsAtNotInPast(
          new Date(now.getTime() - BOOKING_START_TOLERANCE_MS + 1_000),
          now,
        ),
      ).not.toThrow();

      let error: AppError | undefined;
      try {
        assertStartsAtNotInPast(
          new Date(now.getTime() - BOOKING_START_TOLERANCE_MS),
          now,
        );
      } catch (caught) {
        error = caught as AppError;
      }

      expect(error).toBeInstanceOf(AppError);
      expect(error?.getStatus()).toBe(400);
      expect(error?.code).toBe('VALIDATION_ERROR');
      expect(error?.details).toEqual([
        { field: 'startsAt', constraints: ['isFuture'] },
      ]);
    });

    it('rejects a past own booking before touching the slot generator', async () => {
      const { service, prisma, slots } = buildService();
      prisma.space.findUnique.mockResolvedValue({
        id: SPACE_ID,
        establishmentId: ESTABLISHMENT_ID,
      });

      const startsAt = new Date(Date.now() - 5 * 60_000);
      const error = await expectAppError(
        service.createForPlayer(USER_ID, {
          spaceId: SPACE_ID,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual([
        { field: 'startsAt', constraints: ['isFuture'] },
      ]);
      expect(slots.generate).not.toHaveBeenCalled();
    });

    it('rejects a past tenant booking before validating the player', async () => {
      const { service, prisma, slots } = buildService();
      prisma.space.findFirst.mockResolvedValue({
        id: SPACE_ID,
        establishmentId: ESTABLISHMENT_ID,
      });

      const startsAt = new Date(Date.now() - 5 * 60_000);
      const error = await expectAppError(
        service.createForTenant(USER_ID, ESTABLISHMENT_ID, {
          spaceId: SPACE_ID,
          playerId: OTHER_USER_ID,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        }),
        400,
        'VALIDATION_ERROR',
      );

      expect(error.details).toEqual([
        { field: 'startsAt', constraints: ['isFuture'] },
      ]);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(slots.generate).not.toHaveBeenCalled();
    });
  });

  describe('F-02: establishment must be active', () => {
    it('rejects an own booking in a suspended establishment with a 404', async () => {
      const { service, prisma, slots } = buildService();
      prisma.space.findUnique.mockResolvedValue({
        id: SPACE_ID,
        establishmentId: ESTABLISHMENT_ID,
      });
      prisma.space.findFirst.mockResolvedValue(
        bookableSpace(EstablishmentStatus.suspended),
      );

      await expectAppError(
        service.createForPlayer(USER_ID, futureRequest()),
        404,
        'ESTABLISHMENT_NOT_FOUND',
      );
      expect(slots.generate).not.toHaveBeenCalled();
    });

    it('rejects a tenant booking in a pending establishment with a 404', async () => {
      const { service, prisma, slots } = buildService();
      prisma.space.findFirst
        .mockResolvedValueOnce({
          id: SPACE_ID,
          establishmentId: ESTABLISHMENT_ID,
        })
        .mockResolvedValueOnce(bookableSpace(EstablishmentStatus.pending));
      prisma.user.findUnique.mockResolvedValue({ status: UserStatus.active });

      await expectAppError(
        service.createForTenant(USER_ID, ESTABLISHMENT_ID, {
          ...futureRequest(),
          playerId: OTHER_USER_ID,
        }),
        404,
        'ESTABLISHMENT_NOT_FOUND',
      );
      expect(slots.generate).not.toHaveBeenCalled();
    });
  });

  describe('F-06: real resource authorization on /me detail/cancel', () => {
    it('sends the real booking attributes to Cerbos and returns 404 on deny', async () => {
      const { service, prisma, permissions, authorization } = buildService();
      const row = bookingRow({
        playerId: OTHER_USER_ID,
        createdByUserId: OTHER_USER_ID,
      });
      prisma.booking.findUnique.mockResolvedValue(row);
      permissions.resolve.mockResolvedValue(playerPrincipal);
      authorization.can.mockResolvedValue(false);

      await expectAppError(
        service.getMine(USER_ID, BOOKING_ID),
        404,
        'BOOKING_NOT_FOUND',
      );

      expect(permissions.resolve).toHaveBeenCalledWith(USER_ID);
      expect(authorization.can).toHaveBeenCalledWith(
        playerPrincipal,
        'booking',
        'read',
        {
          id: BOOKING_ID,
          playerId: OTHER_USER_ID,
          establishmentId: ESTABLISHMENT_ID,
          status: BookingStatus.confirmed,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
        },
      );
    });

    it('denies cancellation of a foreign booking before the state checks', async () => {
      const { service, prisma, permissions, authorization } = buildService();
      const row = bookingRow({
        playerId: OTHER_USER_ID,
        status: BookingStatus.cancelled,
        startsAt: new Date(Date.now() - 60 * 60_000),
        endsAt: new Date(Date.now() - 30 * 60_000),
      });
      prisma.booking.findUnique.mockResolvedValue(row);
      permissions.resolve.mockResolvedValue(playerPrincipal);
      authorization.can.mockResolvedValue(false);

      await expectAppError(
        service.cancelMine(USER_ID, BOOKING_ID),
        404,
        'BOOKING_NOT_FOUND',
      );

      expect(authorization.can).toHaveBeenCalledWith(
        playerPrincipal,
        'booking',
        'cancel',
        expect.objectContaining({
          id: BOOKING_ID,
          playerId: OTHER_USER_ID,
          status: BookingStatus.cancelled,
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.booking.updateMany).not.toHaveBeenCalled();
    });

    it('keeps platform-admin scoped to its own bookings even when Cerbos allows', async () => {
      const { service, prisma, permissions, authorization } = buildService();
      prisma.booking.findUnique.mockResolvedValue(
        bookingRow({ playerId: OTHER_USER_ID }),
      );
      permissions.resolve.mockResolvedValue(platformPrincipal);
      authorization.can.mockResolvedValue(true);

      await expectAppError(
        service.getMine(USER_ID, BOOKING_ID),
        404,
        'BOOKING_NOT_FOUND',
      );
      expect(authorization.can).toHaveBeenCalled();
    });

    it('allows an owned booking when Cerbos allows', async () => {
      const { service, prisma, permissions, authorization } = buildService();
      const row = bookingRow();
      prisma.booking.findUnique.mockResolvedValue(row);
      permissions.resolve.mockResolvedValue(playerPrincipal);
      authorization.can.mockResolvedValue(true);

      await expect(service.getMine(USER_ID, BOOKING_ID)).resolves.toEqual(
        expect.objectContaining({
          id: BOOKING_ID,
          playerId: USER_ID,
          status: BookingStatus.confirmed,
        }),
      );
    });

    it('does not call Cerbos for a missing booking', async () => {
      const { service, prisma, permissions, authorization } = buildService();
      prisma.booking.findUnique.mockResolvedValue(null);

      await expectAppError(
        service.getMine(USER_ID, BOOKING_ID),
        404,
        'BOOKING_NOT_FOUND',
      );
      expect(permissions.resolve).not.toHaveBeenCalled();
      expect(authorization.can).not.toHaveBeenCalled();
    });
  });
});
