import { Injectable } from '@nestjs/common';
import type {
  AuthorizationService as AuthorizationServiceContract,
  AuthorizedPrincipal,
  QueryPlan,
} from './authorization.types';
import { CerbosClient } from './cerbos.client';
import type { CerbosPrincipal, CerbosResource } from './cerbos.client';

/**
 * PEP adapter over the Cerbos client.
 *
 * The principal is rebuilt for every call from the tenant-scoped permissions
 * provided by the resolver: no decisions are cached here, and no permissions
 * from other memberships are merged in.
 */
@Injectable()
export class CerbosAuthorizationService
  implements AuthorizationServiceContract
{
  constructor(private readonly cerbos: CerbosClient) {}

  async can(
    principal: AuthorizedPrincipal,
    resourceKind: string,
    action: string,
    resource?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.cerbos.check(
      this.toCerbosPrincipal(principal),
      this.toCerbosResource(resourceKind, principal, resource),
      action,
    );
  }

  async plan(
    principal: AuthorizedPrincipal,
    resourceKind: string,
    action: string,
  ): Promise<QueryPlan> {
    return this.cerbos.plan(
      this.toCerbosPrincipal(principal),
      resourceKind,
      action,
    );
  }

  private toCerbosPrincipal(principal: AuthorizedPrincipal): CerbosPrincipal {
    return {
      id: principal.userId,
      roles: ['authenticated'],
      attr: {
        permissions: principal.permissions,
        establishmentId: principal.establishmentId ?? null,
        membershipStatus: principal.membershipStatus ?? null,
        isPlatformAdmin: principal.isPlatformAdmin,
      },
    };
  }

  private toCerbosResource(
    resourceKind: string,
    principal: AuthorizedPrincipal,
    resource?: Record<string, unknown>,
  ): CerbosResource {
    const { id, ...attr } = resource ?? {};
    const resourceId =
      typeof id === 'string' && id.length > 0
        ? id
        : `${resourceKind}:${principal.userId}`;

    return {
      kind: resourceKind,
      id: resourceId,
      attr,
    };
  }
}

/** Ergonomic alias for Nest wiring (`useClass: AuthorizationService`). */
export { CerbosAuthorizationService as AuthorizationService };
