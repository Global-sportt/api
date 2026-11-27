import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '../decorators/public.decorator';
import { AppError } from '../errors/app-error';
import type { AppLogger } from '../logging/app-logger.service';
import { AuthenticatedOnly } from './authenticated-only.decorator';
import { Authorize } from './authorize.decorator';
import { AuthorizationGuard } from './authorization.guard';
import type {
  AuthorizationService,
  AuthorizedPrincipal,
  PermissionResolver,
} from './authorization.types';

class BookingController {
  @Authorize('booking', 'read')
  read(): void {}

  @Authorize('booking', 'create')
  create(): void {}

  @Authorize('booking', 'cancel')
  cancel(): void {}
}

class PublicController {
  @Public()
  ping(): void {}
}

class AuthenticatedOnlyController {
  @AuthenticatedOnly()
  me(): void {}
}

class UnprotectedController {
  read(): void {}
}

const authorizedPrincipal: AuthorizedPrincipal = {
  userId: 'user-1',
  permissions: { 'booking:read': 'establishment' },
  establishmentId: 'E1',
  membershipStatus: 'active',
  isPlatformAdmin: false,
};

const playerPrincipal: AuthorizedPrincipal = {
  userId: 'user_a',
  permissions: {
    'booking:read': 'own',
    'booking:create': 'own',
    'booking:cancel': 'own',
  },
  isPlatformAdmin: false,
};

const platformAdminPrincipal: AuthorizedPrincipal = {
  userId: 'admin-1',
  permissions: {
    'booking:read': 'platform',
    'booking:create': 'platform',
    'booking:cancel': 'platform',
  },
  isPlatformAdmin: true,
};

interface FakeAuthorizationService {
  can: jest.Mock;
  decide?: jest.Mock;
  plan: jest.Mock;
}

interface FakePermissionResolver {
  resolve: jest.Mock;
}

function setup(
  logger?: AppLogger,
): {
  guard: AuthorizationGuard;
  authorization: FakeAuthorizationService;
  permissions: FakePermissionResolver;
} {
  const authorization: FakeAuthorizationService = {
    can: jest.fn(),
    plan: jest.fn(),
  };
  const permissions: FakePermissionResolver = {
    resolve: jest.fn(),
  };

  return {
    guard: new AuthorizationGuard(
      new Reflector(),
      authorization as unknown as AuthorizationService,
      permissions as unknown as PermissionResolver,
      logger,
    ),
    authorization,
    permissions,
  };
}

function createContext(
  handler: () => void,
  controller: new () => unknown,
  request: Record<string, unknown>,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function authenticatedRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'req-123',
    originalUrl: '/bookings',
    principal: { userId: 'user-1', sessionId: 'session-1', role: 'player' },
    params: { establishmentId: 'E1', bookingId: 'booking-1' },
    tenant: { establishmentId: 'E1' },
    ...overrides,
  };
}

describe('AuthorizationGuard', () => {
  it('permite cuando el servicio autoriza y adjunta la decisión', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      authorizationResource: { playerId: 'user-1' },
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(permissions.resolve).toHaveBeenCalledWith('user-1', 'E1');
    expect(authorization.can).toHaveBeenCalledWith(
      authorizedPrincipal,
      'booking',
      'read',
      expect.objectContaining({
        id: 'booking-1',
        establishmentId: 'E1',
        playerId: 'user-1',
      }),
      'req-123',
    );
    expect(request.authz).toEqual({
      resource: 'booking',
      action: 'read',
      permission: 'booking:read',
      decision: 'allow',
    });
  });

  it('deniega con 403 PERMISSION_DENIED cuando Cerbos devuelve DENY', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockResolvedValue(false);

    const operation = guard.canActivate(
      createContext(
        BookingController.prototype.read,
        BookingController,
        authenticatedRequest(),
      ),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
    await expect(operation).rejects.toBeInstanceOf(AppError);
  });

  it('deniega una ruta privada sin @Authorize (fail closed)', async () => {
    const { guard, authorization, permissions } = setup();

    const operation = guard.canActivate(
      createContext(
        UnprotectedController.prototype.read,
        UnprotectedController,
        authenticatedRequest(),
      ),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
    expect(permissions.resolve).not.toHaveBeenCalled();
    expect(authorization.can).not.toHaveBeenCalled();
  });

  it('omite las rutas públicas sin metadata', async () => {
    const { guard, authorization, permissions } = setup();

    await expect(
      guard.canActivate(
        createContext(
          PublicController.prototype.ping,
          PublicController,
          authenticatedRequest(),
        ),
      ),
    ).resolves.toBe(true);

    expect(permissions.resolve).not.toHaveBeenCalled();
    expect(authorization.can).not.toHaveBeenCalled();
  });

  it('permite una ruta @AuthenticatedOnly con principal sin llamar a Cerbos', async () => {
    const { guard, authorization, permissions } = setup();

    await expect(
      guard.canActivate(
        createContext(
          AuthenticatedOnlyController.prototype.me,
          AuthenticatedOnlyController,
          authenticatedRequest({ tenant: undefined, params: {} }),
        ),
      ),
    ).resolves.toBe(true);

    expect(permissions.resolve).not.toHaveBeenCalled();
    expect(authorization.can).not.toHaveBeenCalled();
  });

  it('exige autenticación en una ruta @AuthenticatedOnly sin principal', async () => {
    const { guard, permissions } = setup();

    const operation = guard.canActivate(
      createContext(
        AuthenticatedOnlyController.prototype.me,
        AuthenticatedOnlyController,
        { id: 'req-123', originalUrl: '/auth/me', params: {} },
      ),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(permissions.resolve).not.toHaveBeenCalled();
  });

  it('adjunta cerbosCallId/requestId y registra la decisión estructurada', async () => {
    const info = jest.fn();
    const logger = { raw: { info } } as unknown as AppLogger;
    const { guard, authorization, permissions } = setup(logger);
    permissions.resolve.mockResolvedValue(playerPrincipal);
    authorization.decide = jest.fn().mockResolvedValue({
      allowed: true,
      cerbosCallId: 'call-1',
      requestId: 'req-123',
    });

    const request = authenticatedRequest({
      principal: { userId: 'user_a', sessionId: 'session-a' },
      tenant: undefined,
      params: {},
      path: '/bookings',
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.create,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(authorization.decide).toHaveBeenCalledWith(
      playerPrincipal,
      'booking',
      'create',
      { playerId: 'user_a' },
      'req-123',
    );
    expect(request.authz).toEqual({
      resource: 'booking',
      action: 'create',
      permission: 'booking:create',
      decision: 'allow',
      cerbosCallId: 'call-1',
      requestId: 'req-123',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'authorization.decision',
        requestId: 'req-123',
        actorId: 'user_a',
        route: '/bookings',
        permission: 'booking:create',
        decision: 'allow',
        cerbosCallId: 'call-1',
        cerbosRequestId: 'req-123',
      }),
      'authorization_decision',
    );
  });

  it('registra y adjunta la correlación también en un DENY', async () => {
    const info = jest.fn();
    const logger = { raw: { info } } as unknown as AppLogger;
    const { guard, authorization, permissions } = setup(logger);
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.decide = jest.fn().mockResolvedValue({
      allowed: false,
      cerbosCallId: 'call-deny',
    });

    const request = authenticatedRequest();

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          request,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });

    expect(request.authz).toMatchObject({
      decision: 'deny',
      cerbosCallId: 'call-deny',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        cerbosCallId: 'call-deny',
      }),
      'authorization_decision',
    );
  });

  it('exige autenticación cuando hay metadata pero no principal', async () => {
    const { guard, authorization, permissions } = setup();

    const operation = guard.canActivate(
      createContext(
        BookingController.prototype.read,
        BookingController,
        { params: {}, tenant: { establishmentId: 'E1' } },
      ),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(permissions.resolve).not.toHaveBeenCalled();
    expect(authorization.can).not.toHaveBeenCalled();
  });

  it('propaga AUTHORIZATION_UNAVAILABLE (503) sin convertirla en allow', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockRejectedValue(
      new AppError(
        503,
        'AUTHORIZATION_UNAVAILABLE',
        'El servicio de autorización no está disponible.',
      ),
    );

    const operation = guard.canActivate(
      createContext(
        BookingController.prototype.read,
        BookingController,
        authenticatedRequest(),
      ),
    );

    await expect(operation).rejects.toMatchObject({
      code: 'AUTHORIZATION_UNAVAILABLE',
      status: 503,
    });
  });

  it('acepta el tenant desde :establishmentId si request.tenant no existe', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({ tenant: undefined });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(permissions.resolve).toHaveBeenCalledWith('user-1', 'E1');
  });

  it('acepta el tenant desde /establishments/:id si request.tenant no existe', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      tenant: undefined,
      path: '/establishments/E1/bookings',
      params: { id: 'E1', bookingId: 'booking-1' },
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(permissions.resolve).toHaveBeenCalledWith('user-1', 'E1');
    expect(authorization.can).toHaveBeenCalledWith(
      authorizedPrincipal,
      'booking',
      'read',
      expect.objectContaining({
        id: 'booking-1',
        establishmentId: 'E1',
      }),
      'req-123',
    );
  });

  it('inyecta playerId en la cancelación propia de /me', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(playerPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      principal: { userId: 'user_a', sessionId: 'session-a' },
      tenant: undefined,
      params: { id: 'booking-1' },
      path: '/me/bookings/booking-1/cancel',
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.cancel,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(authorization.can).toHaveBeenCalledWith(
      playerPrincipal,
      'booking',
      'cancel',
      { id: 'booking-1', playerId: 'user_a' },
      'req-123',
    );
  });

  it('inyecta playerId al crear una reserva propia', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(playerPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      principal: { userId: 'user_a', sessionId: 'session-a' },
      tenant: undefined,
      params: {},
      path: '/bookings',
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.create,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(authorization.can).toHaveBeenCalledWith(
      playerPrincipal,
      'booking',
      'create',
      { playerId: 'user_a' },
      'req-123',
    );
  });

  it('usa el id del platform-admin como playerId en contexto propio', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(platformAdminPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      principal: { userId: 'admin-1', sessionId: 'session-admin' },
      tenant: undefined,
      params: {},
      path: '/me/bookings',
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(authorization.can).toHaveBeenCalledWith(
      platformAdminPrincipal,
      'booking',
      'read',
      { playerId: 'admin-1' },
      'req-123',
    );
  });

  it('no inyecta playerId en rutas tenant para staff E1', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(authorizedPrincipal);
    authorization.can.mockResolvedValue(true);

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.read,
          BookingController,
          authenticatedRequest(),
        ),
      ),
    ).resolves.toBe(true);

    const resource = authorization.can.mock.calls[0][3] as Record<
      string,
      unknown
    >;
    expect(resource).toEqual({
      id: 'booking-1',
      establishmentId: 'E1',
    });
    expect(resource).not.toHaveProperty('playerId');
  });

  it('respeta un playerId explícito de authorizationResource', async () => {
    const { guard, authorization, permissions } = setup();
    permissions.resolve.mockResolvedValue(playerPrincipal);
    authorization.can.mockResolvedValue(true);

    const request = authenticatedRequest({
      principal: { userId: 'user_a', sessionId: 'session-a' },
      tenant: undefined,
      params: { id: 'booking-1' },
      path: '/me/bookings/booking-1/cancel',
      authorizationResource: { playerId: 'user_explicit' },
    });

    await expect(
      guard.canActivate(
        createContext(
          BookingController.prototype.cancel,
          BookingController,
          request,
        ),
      ),
    ).resolves.toBe(true);

    expect(authorization.can).toHaveBeenCalledWith(
      playerPrincipal,
      'booking',
      'cancel',
      { id: 'booking-1', playerId: 'user_explicit' },
      'req-123',
    );
  });
});
