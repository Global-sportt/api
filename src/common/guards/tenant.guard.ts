import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { MembershipStatus } from '@prisma/client';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';
import { AppLogger } from '../logging/app-logger.service';
import {
  AUTHZ_PERMISSION_RESOLVER,
  type PermissionResolver,
} from '../authz/authorization.types';
import type { TenantRequestContext } from '../types/express';
import { PrismaService } from '../../prisma/prisma.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the tenant context for routes that carry an establishment id.
 *
 * Contract (Q4/Q9):
 * - No tenant param → pass through (the guard is only useful on tenant routes).
 * - Unknown establishment → 404 `ESTABLISHMENT_NOT_FOUND`.
 * - Existing establishment without an **active** membership → 403
 *   `TENANT_FORBIDDEN` (unless the caller is a platform admin).
 * - Platform admin bypasses the membership check and the access is audited.
 *
 * `isPlatformAdmin` comes from `PermissionResolver`, never from ad-hoc group
 * SQL in this guard.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTHZ_PERMISSION_RESOLVER)
    private readonly permissions: PermissionResolver,
    private readonly logger: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const establishmentId = readEstablishmentId(request);

    // Routes without a tenant param are not tenant routes; leave them alone.
    if (!establishmentId) return true;

    const principal = request.principal;
    if (!principal) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'Se requiere autenticación para acceder a este recurso.',
      );
    }

    if (!UUID_PATTERN.test(establishmentId)) {
      throw notFound();
    }

    const establishment = await this.prisma.establishment.findUnique({
      where: { id: establishmentId },
      select: { id: true },
    });

    if (!establishment) {
      throw notFound();
    }

    const [resolved, membership] = await Promise.all([
      this.permissions.resolve(principal.userId, establishmentId),
      this.prisma.membership.findUnique({
        where: {
          userId_establishmentId: {
            userId: principal.userId,
            establishmentId,
          },
        },
        select: { id: true, status: true },
      }),
    ]);

    if (membership?.status === MembershipStatus.active) {
      request.tenant = {
        establishmentId,
        membershipId: membership.id,
        status: membership.status,
        isPlatformAdmin: resolved.isPlatformAdmin,
        auditBypass: false,
      };
      return true;
    }

    if (resolved.isPlatformAdmin) {
      const tenant: TenantRequestContext = {
        establishmentId,
        status: membership?.status,
        isPlatformAdmin: true,
        auditBypass: true,
      };
      request.tenant = tenant;

      // Q10: platform-admin access to a tenant without membership is audited
      // with the structured fields available at this layer. Cerbos adds its
      // decision log/`cerbosCallId` when AuthorizationGuard evaluates.
      this.logger.raw.info(
        {
          event: 'tenant.platform_admin_bypass',
          actorId: principal.userId,
          establishmentId,
          membershipStatus: membership?.status ?? null,
          route: request.originalUrl.split('?')[0],
          decision: 'allow',
        },
        'tenant_access_without_membership',
      );

      return true;
    }

    throw new AppError(
      403,
      'TENANT_FORBIDDEN',
      'No tienes una membresía activa en este establecimiento.',
    );
  }
}

function readEstablishmentId(request: Request): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const candidate = params?.establishmentId ?? params?.id;

  if (typeof candidate !== 'string') return undefined;

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function notFound(): AppError {
  return new AppError(
    404,
    'ESTABLISHMENT_NOT_FOUND',
    'El establecimiento no existe.',
  );
}
