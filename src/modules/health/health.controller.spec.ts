import { AppError } from '../../common/errors/app-error';
import {
  CerbosClient,
  type CerbosTransport,
} from '../../common/authz/cerbos.client';
import type { PrismaService } from '../../prisma/prisma.service';
import { HealthController } from './health.controller';

function setup(): {
  controller: HealthController;
  prisma: { $queryRaw: jest.Mock };
  transport: jest.Mocked<CerbosTransport>;
} {
  const prisma = { $queryRaw: jest.fn() };
  const transport = {
    checkResources: jest.fn(),
    planResources: jest.fn(),
    health: jest.fn(),
  } as jest.Mocked<CerbosTransport>;
  const controller = new HealthController(
    prisma as unknown as PrismaService,
    new CerbosClient({ transport, timeoutMs: 20 }),
  );

  return { controller, prisma, transport };
}

describe('HealthController readiness', () => {
  it('reporta database y cerbos OK sin exponer detalles internos', async () => {
    const { controller, prisma, transport } = setup();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    transport.health.mockResolvedValue(true);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'ok',
      cerbos: 'ok',
      timestamp: expect.any(String),
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transport.health).toHaveBeenCalledTimes(1);
  });

  it('responde 503 AUTHORIZATION_UNAVAILABLE si Cerbos no está sano', async () => {
    const { controller, prisma, transport } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    transport.health.mockResolvedValue(false);

    const error = await controller.ready().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'AUTHORIZATION_UNAVAILABLE',
      status: 503,
    });
  });

  it('responde 503 AUTHORIZATION_UNAVAILABLE si el health de Cerbos falla', async () => {
    const { controller, prisma, transport } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    transport.health.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(controller.ready()).rejects.toMatchObject({
      code: 'AUTHORIZATION_UNAVAILABLE',
      status: 503,
    });
  });

  it('mantiene DATABASE_UNAVAILABLE si PostgreSQL falla', async () => {
    const { controller, prisma, transport } = setup();
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    transport.health.mockResolvedValue(true);

    await expect(controller.ready()).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      status: 503,
    });
  });
});
