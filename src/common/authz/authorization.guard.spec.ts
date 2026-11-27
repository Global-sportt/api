import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '../decorators/public.decorator';
import { AppError } from '../errors/app-error';
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
  plan: jest.Mock;
}

interface FakePermissionResolver {
  resolve: jest.Mock;
}

function setup(): {
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
    );
    expect(request.authz).toEqual({
      resource: 'booking',
      action: 'read',
      permission: 'booking:read',
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
    );
  });
});
