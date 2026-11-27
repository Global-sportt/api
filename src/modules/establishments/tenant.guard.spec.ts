import { ExecutionContext } from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import type { PermissionResolver } from '../../common/authz/authorization.types';
import { AppError } from '../../common/errors/app-error';
import { TenantGuard } from '../../common/guards/tenant.guard';
import type { AppLogger } from '../../common/logging/app-logger.service';
import type { PrismaService } from '../../prisma/prisma.service';

const ESTABLISHMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ESTABLISHMENT_ID = '22222222-2222-4222-8222-222222222222';

interface RequestStub {
  params: Record<string, string>;
  principal?: { userId: string; sessionId: string };
  originalUrl: string;
  tenant?: unknown;
}

function buildContext(params: Record<string, string>): {
  context: ExecutionContext;
  request: RequestStub;
} {
  const request: RequestStub = {
    params,
    principal: { userId: 'u-1', sessionId: 's-1' },
    originalUrl: '/api/v1/establishments/context',
  };

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;

  return { context, request };
}

async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Se esperaba un AppError ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(status);
    expect(appError.code).toBe(code);
  }
}

describe('TenantGuard', () => {
  let prisma: {
    establishment: { findUnique: jest.Mock };
    membership: { findUnique: jest.Mock };
  };
  let resolver: { resolve: jest.Mock };
  let logger: { raw: { info: jest.Mock } };
  let guard: TenantGuard;

  beforeEach(() => {
    prisma = {
      establishment: { findUnique: jest.fn() },
      membership: { findUnique: jest.fn() },
    };
    resolver = { resolve: jest.fn() };
    logger = { raw: { info: jest.fn() } };

    resolver.resolve.mockResolvedValue({
      userId: 'u-1',
      permissions: {},
      establishmentId: ESTABLISHMENT_ID,
      isPlatformAdmin: false,
    });

    guard = new TenantGuard(
      prisma as unknown as PrismaService,
      resolver as unknown as PermissionResolver,
      logger as unknown as AppLogger,
    );
  });

  it('pasa sin tocar la base cuando la ruta no tiene parámetro de tenant', async () => {
    const { context } = buildContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('lee :id cuando la ruta es /establishments/:id', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      status: MembershipStatus.active,
    });
    const { context, request } = buildContext({ id: ESTABLISHMENT_ID });

    await guard.canActivate(context);

    expect(prisma.establishment.findUnique).toHaveBeenCalledWith({
      where: { id: ESTABLISHMENT_ID },
      select: { id: true },
    });
    expect(resolver.resolve).toHaveBeenCalledWith(
      'u-1',
      ESTABLISHMENT_ID,
    );
    expect(request.tenant).toEqual({
      establishmentId: ESTABLISHMENT_ID,
      membershipId: 'm-1',
      status: MembershipStatus.active,
      isPlatformAdmin: false,
      auditBypass: false,
    });
  });

  it('prefiere :establishmentId sobre :id', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-1',
      status: MembershipStatus.active,
    });
    const { context } = buildContext({
      establishmentId: ESTABLISHMENT_ID,
      id: OTHER_ESTABLISHMENT_ID,
    });

    await guard.canActivate(context);

    expect(prisma.establishment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ESTABLISHMENT_ID } }),
    );
  });

  it('devuelve 404 ESTABLISHMENT_NOT_FOUND si la sede no existe', async () => {
    prisma.establishment.findUnique.mockResolvedValue(null);
    const { context } = buildContext({ id: ESTABLISHMENT_ID });

    await expectAppError(
      guard.canActivate(context),
      404,
      'ESTABLISHMENT_NOT_FOUND',
    );

    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('devuelve 404 para un id que no es UUID sin consultar Prisma', async () => {
    const { context } = buildContext({ id: 'no-es-uuid' });

    await expectAppError(
      guard.canActivate(context),
      404,
      'ESTABLISHMENT_NOT_FOUND',
    );

    expect(prisma.establishment.findUnique).not.toHaveBeenCalled();
  });

  it('devuelve 403 TENANT_FORBIDDEN sin membresía y sin ser platform-admin', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue(null);
    const { context } = buildContext({ id: ESTABLISHMENT_ID });

    await expectAppError(
      guard.canActivate(context),
      403,
      'TENANT_FORBIDDEN',
    );
  });

  it('trata membresías invited/suspended/removed como sin membresía activa', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });

    for (const status of [
      MembershipStatus.invited,
      MembershipStatus.suspended,
      MembershipStatus.removed,
    ]) {
      prisma.membership.findUnique.mockResolvedValue({
        id: 'm-1',
        status,
      });
      const { context } = buildContext({ id: ESTABLISHMENT_ID });

      await expectAppError(
        guard.canActivate(context),
        403,
        'TENANT_FORBIDDEN',
      );
    }
  });

  it('permite platform-admin sin membresía, adjunta flag de auditoría y registra el bypass', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue(null);
    resolver.resolve.mockResolvedValue({
      userId: 'u-admin',
      permissions: {},
      establishmentId: ESTABLISHMENT_ID,
      isPlatformAdmin: true,
    });
    const { context, request } = buildContext({ id: ESTABLISHMENT_ID });
    if (request.principal) request.principal.userId = 'u-admin';

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.tenant).toEqual({
      establishmentId: ESTABLISHMENT_ID,
      status: undefined,
      isPlatformAdmin: true,
      auditBypass: true,
    });
    expect(logger.raw.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tenant.platform_admin_bypass',
        actorId: 'u-admin',
        establishmentId: ESTABLISHMENT_ID,
        decision: 'allow',
      }),
      'tenant_access_without_membership',
    );
  });

  it('platform-admin con membresía activa no marca bypass', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-admin',
      status: MembershipStatus.active,
    });
    resolver.resolve.mockResolvedValue({
      userId: 'u-admin',
      permissions: {},
      establishmentId: ESTABLISHMENT_ID,
      isPlatformAdmin: true,
    });
    const { context, request } = buildContext({ id: ESTABLISHMENT_ID });
    if (request.principal) request.principal.userId = 'u-admin';

    await guard.canActivate(context);

    expect(request.tenant).toEqual(
      expect.objectContaining({
        membershipId: 'm-admin',
        isPlatformAdmin: true,
        auditBypass: false,
      }),
    );
    expect(logger.raw.info).not.toHaveBeenCalled();
  });

  it('platform-admin con membresía suspendida usa el bypass auditado', async () => {
    prisma.establishment.findUnique.mockResolvedValue({
      id: ESTABLISHMENT_ID,
    });
    prisma.membership.findUnique.mockResolvedValue({
      id: 'm-admin',
      status: MembershipStatus.suspended,
    });
    resolver.resolve.mockResolvedValue({
      userId: 'u-admin',
      permissions: {},
      establishmentId: ESTABLISHMENT_ID,
      isPlatformAdmin: true,
    });
    const { context, request } = buildContext({ id: ESTABLISHMENT_ID });
    if (request.principal) request.principal.userId = 'u-admin';

    await guard.canActivate(context);

    expect(request.tenant).toEqual({
      establishmentId: ESTABLISHMENT_ID,
      status: MembershipStatus.suspended,
      isPlatformAdmin: true,
      auditBypass: true,
    });
  });
});
