import { CerbosAuthorizationService } from './authorization.service';
import type { AuthorizedPrincipal } from './authorization.types';
import { PLAN_KIND } from './authorization.types';
import type { CerbosClient } from './cerbos.client';

interface FakeCerbosClient {
  check: jest.Mock;
  plan: jest.Mock;
}

const principal: AuthorizedPrincipal = {
  userId: 'user-1',
  permissions: {
    'booking:read': 'establishment',
    'space:read': 'establishment',
  },
  establishmentId: 'E1',
  membershipStatus: 'active',
  isPlatformAdmin: false,
};

function setup(): {
  service: CerbosAuthorizationService;
  cerbos: FakeCerbosClient;
} {
  const cerbos: FakeCerbosClient = {
    check: jest.fn(),
    plan: jest.fn(),
  };

  return {
    service: new CerbosAuthorizationService(
      cerbos as unknown as CerbosClient,
    ),
    cerbos,
  };
}

describe('CerbosAuthorizationService', () => {
  it('construye el principal de Cerbos y delega el check de un recurso', async () => {
    const { service, cerbos } = setup();
    cerbos.check.mockResolvedValue(true);

    await expect(
      service.can(principal, 'booking', 'read', {
        id: 'booking-1',
        playerId: 'user-1',
        establishmentId: 'E1',
      }),
    ).resolves.toBe(true);

    expect(cerbos.check).toHaveBeenCalledWith(
      {
        id: 'user-1',
        roles: ['authenticated'],
        attr: {
          permissions: principal.permissions,
          establishmentId: 'E1',
          membershipStatus: 'active',
          isPlatformAdmin: false,
        },
      },
      {
        kind: 'booking',
        id: 'booking-1',
        attr: {
          playerId: 'user-1',
          establishmentId: 'E1',
        },
      },
      'read',
    );
  });

  it('no inventa un id cuando el recurso no lo trae', async () => {
    const { service, cerbos } = setup();
    cerbos.check.mockResolvedValue(false);

    await expect(service.can(principal, 'space', 'read')).resolves.toBe(false);

    expect(cerbos.check).toHaveBeenCalledWith(
      expect.any(Object),
      {
        kind: 'space',
        id: 'space:user-1',
        attr: {},
      },
      'read',
    );
  });

  it('propaga un DENY explícito como false', async () => {
    const { service, cerbos } = setup();
    cerbos.check.mockResolvedValue(false);

    await expect(
      service.can(principal, 'booking', 'read', {
        id: 'booking-2',
        playerId: 'user-2',
      }),
    ).resolves.toBe(false);
  });

  it('representa el contexto global con establishmentId null', async () => {
    const { service, cerbos } = setup();
    cerbos.check.mockResolvedValue(true);

    await service.can(
      {
        userId: 'user-2',
        permissions: { 'booking:read': 'own' },
        isPlatformAdmin: false,
      },
      'booking',
      'read',
      { id: 'booking-3', playerId: 'user-2' },
    );

    expect(cerbos.check).toHaveBeenCalledWith(
      expect.objectContaining({
        attr: expect.objectContaining({
          establishmentId: null,
          membershipStatus: null,
          isPlatformAdmin: false,
        }),
      }),
      expect.any(Object),
      'read',
    );
  });

  it('delega PlanResources sin cachear decisiones', async () => {
    const { service, cerbos } = setup();
    const plan = { kind: PLAN_KIND.ALWAYS_ALLOWED };
    cerbos.plan.mockResolvedValue(plan);

    await expect(service.plan(principal, 'booking', 'read')).resolves.toBe(
      plan,
    );
    await expect(service.plan(principal, 'booking', 'read')).resolves.toBe(
      plan,
    );

    expect(cerbos.plan).toHaveBeenCalledTimes(2);
    expect(cerbos.plan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'user-1', roles: ['authenticated'] }),
      'booking',
      'read',
    );
  });

  it('repite el check en cada llamada (sin caché de decisiones)', async () => {
    const { service, cerbos } = setup();
    cerbos.check.mockResolvedValue(true);

    await service.can(principal, 'space', 'read', { id: 'S1' });
    await service.can(principal, 'space', 'read', { id: 'S1' });

    expect(cerbos.check).toHaveBeenCalledTimes(2);
  });
});
