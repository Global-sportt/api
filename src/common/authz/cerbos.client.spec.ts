import { AppError } from '../errors/app-error';
import { CerbosAuthorizationService } from './authorization.service';
import type { AuthorizedPrincipal } from './authorization.types';
import { PLAN_KIND } from './authorization.types';
import { CerbosClient } from './cerbos.client';
import type { CerbosTransport } from './cerbos.client';

const principal = {
  id: 'user-1',
  roles: ['authenticated'],
  attr: { permissions: { 'booking:read': 'own' } },
};

const resource = {
  kind: 'booking',
  id: 'booking-1',
  attr: { playerId: 'user-1', establishmentId: 'E1' },
};

function setup(timeoutMs = 50): {
  client: CerbosClient;
  transport: jest.Mocked<CerbosTransport>;
} {
  const transport = {
    checkResources: jest.fn(),
    planResources: jest.fn(),
  } as jest.Mocked<CerbosTransport>;

  return {
    client: new CerbosClient({ transport, timeoutMs }),
    transport,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function authorizationUnavailable(
  operation: Promise<unknown>,
): Promise<AppError> {
  const error = await operation.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(AppError);

  const appError = error as AppError;
  expect(appError.code).toBe('AUTHORIZATION_UNAVAILABLE');
  expect(appError.getStatus()).toBe(503);

  return appError;
}

describe('CerbosClient with an injected transport', () => {
  it('devuelve allow para EFFECT_ALLOW', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ actions: { read: 'EFFECT_ALLOW' } }],
    });

    await expect(client.check(principal, resource, 'read')).resolves.toBe(
      true,
    );

    expect(transport.checkResources).toHaveBeenCalledWith(
      {
        principal,
        resources: [{ resource, actions: ['read'] }],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('devuelve deny para EFFECT_DENY', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ actions: { read: 'EFFECT_DENY' } }],
    });

    await expect(client.check(principal, resource, 'read')).resolves.toBe(
      false,
    );
  });

  it('falla cerrado si falta la decisión de la acción', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ actions: {} }],
    });

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('falla cerrado si la respuesta no trae resultado', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({ results: [] });

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea un error de red a AUTHORIZATION_UNAVAILABLE', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea el timeout a AUTHORIZATION_UNAVAILABLE aunque el transporte no reaccione', async () => {
    const { client, transport } = setup(10);
    transport.checkResources.mockImplementation(() => new Promise(() => {}));

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('devuelve el plan del transporte para listados', async () => {
    const { client, transport } = setup();
    const plan = { kind: PLAN_KIND.ALWAYS_ALLOWED };
    transport.planResources.mockResolvedValue(plan as never);

    await expect(client.plan(principal, 'booking', 'read')).resolves.toBe(
      plan,
    );

    expect(transport.planResources).toHaveBeenCalledWith(
      {
        principal,
        resource: { kind: 'booking' },
        action: 'read',
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('mapea un plan con kind desconocido a AUTHORIZATION_UNAVAILABLE', async () => {
    const { client, transport } = setup();
    transport.planResources.mockResolvedValue({
      kind: 'KIND_UNKNOWN',
    } as never);

    await authorizationUnavailable(client.plan(principal, 'booking', 'read'));
  });
});

describe('FetchCerbosTransport (native fetch)', () => {
  let fetchSpy: jest.SpyInstance;
  let client: CerbosClient;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    client = new CerbosClient({
      url: 'http://cerbos.test/',
      timeoutMs: 20,
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('hace POST a check/resources y mapea EFFECT_ALLOW', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        requestId: 'req-1',
        results: [{ actions: { read: 'EFFECT_ALLOW' } }],
        cerbosCallId: 'call-1',
      }),
    );

    await expect(client.check(principal, resource, 'read')).resolves.toBe(
      true,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://cerbos.test/api/check/resources',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: expect.any(String),
      }),
    );

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      principal,
      resources: [{ resource, actions: ['read'] }],
    });
    expect(typeof payload.requestId).toBe('string');
  });

  it('mapea EFFECT_DENY a false', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [{ actions: { read: 'EFFECT_DENY' } }],
      }),
    );

    await expect(client.check(principal, resource, 'read')).resolves.toBe(
      false,
    );
  });

  it('mapea un efecto desconocido a AUTHORIZATION_UNAVAILABLE', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [{ actions: { read: 'EFFECT_UNKNOWN' } }],
      }),
    );

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('falla cerrado si falta la acción en la respuesta', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [{ actions: {} }],
      }),
    );

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('falla cerrado si la respuesta no trae actions', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [{}],
      }),
    );

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea un status no 2xx a AUTHORIZATION_UNAVAILABLE', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: 'unavailable' }, 503),
    );

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea un fallo de fetch a AUTHORIZATION_UNAVAILABLE', async () => {
    fetchSpy.mockRejectedValue(new Error('socket hang up'));

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea el timeout del fetch a AUTHORIZATION_UNAVAILABLE', async () => {
    client = new CerbosClient({ url: 'http://cerbos.test', timeoutMs: 10 });
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('mapea filter CONDITIONAL a kind/condition y conserva metadata', async () => {
    const condition = {
      expression: {
        operator: 'eq',
        operands: [
          { variable: 'request.resource.attr.playerId' },
          { value: 'user-1' },
        ],
      },
    };

    fetchSpy.mockResolvedValue(
      jsonResponse({
        requestId: 'req-plan-1',
        action: 'read',
        resourceKind: 'booking',
        filter: { kind: 'KIND_CONDITIONAL', condition },
        cerbosCallId: 'call-plan-1',
      }),
    );

    await expect(client.plan(principal, 'booking', 'read')).resolves.toEqual({
      kind: 'KIND_CONDITIONAL',
      condition,
      requestId: 'req-plan-1',
      cerbosCallId: 'call-plan-1',
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://cerbos.test/api/plan/resources',
      expect.objectContaining({ method: 'POST' }),
    );

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      principal,
      resource: { kind: 'booking' },
      action: 'read',
    });
    expect(typeof payload.requestId).toBe('string');
  });

  it.each([PLAN_KIND.ALWAYS_ALLOWED, PLAN_KIND.ALWAYS_DENIED])(
    'mapea un plan %s sin condición',
    async (kind) => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          requestId: 'req-plan-2',
          action: 'read',
          resourceKind: 'booking',
          filter: { kind },
          cerbosCallId: 'call-plan-2',
        }),
      );

      await expect(client.plan(principal, 'booking', 'read')).resolves.toEqual(
        {
          kind,
          requestId: 'req-plan-2',
          cerbosCallId: 'call-plan-2',
        },
      );
    },
  );

  it('falla cerrado si filter.kind es desconocido', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        filter: { kind: 'KIND_UNKNOWN' },
      }),
    );

    await authorizationUnavailable(client.plan(principal, 'booking', 'read'));
  });

  it('falla cerrado si falta filter en el plan', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}));

    await authorizationUnavailable(client.plan(principal, 'booking', 'read'));
  });
});

const describeSmoke =
  process.env.CERBOS_SMOKE === '1' ? describe : describe.skip;

describeSmoke('real Cerbos smoke (set CERBOS_SMOKE=1)', () => {
  const url = process.env.CERBOS_URL ?? 'http://127.0.0.1:3592';
  const service = new CerbosAuthorizationService(
    new CerbosClient({ url }),
  );

  const player: AuthorizedPrincipal = {
    userId: 'user_a',
    permissions: {
      'booking:read': 'own',
      'booking:create': 'own',
      'booking:cancel': 'own',
    },
    isPlatformAdmin: false,
  };

  const staff: AuthorizedPrincipal = {
    userId: 'user_staff_e1',
    permissions: {
      'booking:read': 'establishment',
      'booking:manage': 'establishment',
    },
    establishmentId: 'E1',
    membershipStatus: 'active',
    isPlatformAdmin: false,
  };

  it(
    'can: player own allow / other deny',
    async () => {
      await expect(
        service.can(player, 'booking', 'read', {
          id: 'booking_a',
          playerId: 'user_a',
          establishmentId: 'E1',
        }),
      ).resolves.toBe(true);

      await expect(
        service.can(player, 'booking', 'read', {
          id: 'booking_b',
          playerId: 'user_b',
          establishmentId: 'E1',
        }),
      ).resolves.toBe(false);
    },
    10_000,
  );

  it(
    'plan: player and staff return adapter-ready conditional plans',
    async () => {
      const playerPlan = await service.plan(player, 'booking', 'read');
      expect(playerPlan.kind).toBe(PLAN_KIND.CONDITIONAL);
      expect('condition' in playerPlan).toBe(true);

      const staffPlan = await service.plan(staff, 'booking', 'read');
      expect(staffPlan.kind).toBe(PLAN_KIND.CONDITIONAL);
      expect('condition' in staffPlan).toBe(true);
    },
    10_000,
  );
});
