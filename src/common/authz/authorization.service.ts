import { Injectable } from '@nestjs/common';
import type {
  AuthorizationDecisionResult,
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
    requestId?: string,
  ): Promise<boolean> {
    const cerbosPrincipal = this.toCerbosPrincipal(principal);
    const cerbosResource = this.toCerbosResource(
      resourceKind,
      principal,
      resource,
    );

    return requestId
      ? this.cerbos.check(cerbosPrincipal, cerbosResource, action, requestId)
      : this.cerbos.check(cerbosPrincipal, cerbosResource, action);
  }

  /**
   * Same PDP call as `can`, but keeps `cerbosCallId`/`requestId` for the
   * guard's structured audit log. No decision is cached.
   */
  async decide(
    principal: AuthorizedPrincipal,
    resourceKind: string,
    action: string,
    resource?: Record<string, unknown>,
    requestId?: string,
  ): Promise<AuthorizationDecisionResult> {
    const cerbosPrincipal = this.toCerbosPrincipal(principal);
    const cerbosResource = this.toCerbosResource(
      resourceKind,
      principal,
      resource,
    );

    return requestId
      ? this.cerbos.checkDetails(
          cerbosPrincipal,
          cerbosResource,
          action,
          requestId,
        )
      : this.cerbos.checkDetails(cerbosPrincipal, cerbosResource, action);
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
