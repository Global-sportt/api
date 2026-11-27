import { AppError } from '../errors/app-error';
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

describe('CerbosClient', () => {
  it('devuelve allow para un check permitido y pasa el timeout como signal', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ isAllowed: () => true }],
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

  it('devuelve deny para un check denegado', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ isAllowed: () => false }],
    });

    await expect(client.check(principal, resource, 'read')).resolves.toBe(
      false,
    );
  });

  it('falla cerrado si la respuesta no trae resultado', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({ results: [] });

    await authorizationUnavailable(client.check(principal, resource, 'read'));
  });

  it('falla cerrado si Cerbos no devuelve decisión para la acción', async () => {
    const { client, transport } = setup();
    transport.checkResources.mockResolvedValue({
      results: [{ isAllowed: () => undefined }],
    });

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

  it('devuelve el plan de Cerbos para listados', async () => {
    const { client, transport } = setup();
    const plan = { kind: PLAN_KIND.CONDITIONAL, condition: {} };
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

  it('mapea un fallo de red al pedir el plan a AUTHORIZATION_UNAVAILABLE', async () => {
    const { client, transport } = setup();
    transport.planResources.mockRejectedValue(new Error('socket hang up'));

    await authorizationUnavailable(client.plan(principal, 'booking', 'read'));
  });
});
