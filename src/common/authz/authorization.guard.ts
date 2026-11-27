import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppError } from '../errors/app-error';
import { AppLogger } from '../logging/app-logger.service';
import { AUTHENTICATED_ONLY_METADATA_KEY } from './authenticated-only.decorator';
import {
  AUTHORIZE_METADATA_KEY,
  AuthorizeMetadata,
} from './authorize.decorator';
import {
  AUTHORIZATION_SERVICE,
  AUTHZ_PERMISSION_RESOLVER,
  AuthorizationDecision,
  AuthorizationDecisionResult,
  AuthorizationService,
  AuthorizedPrincipal,
  PermissionResolver,
} from './authorization.types';

/**
 * Request state owned by the authorization layer. It is read through a cast
 * instead of augmenting Express.Request so this module does not conflict with
 * the tenant/auth typings that A2a is evolving in parallel.
 */
interface AuthorizationState {
  /** Set by the tenant layer when the route resolves an establishment. */
  tenant?: unknown;
  /** Decision metadata attached before/after the check. */
  authz?: AuthorizationDecision;
  /**
   * Optional attribute bag supplied by a handler/interceptor when the resource
   * is already known (for example `playerId` for an owned booking). Values are
   * passed to Cerbos as `request.resource.attr`.
   */
  authorizationResource?: unknown;
}

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHORIZATION_SERVICE)
    private readonly authorization: AuthorizationService,
    @Inject(AUTHZ_PERMISSION_RESOLVER)
    private readonly permissions: PermissionResolver,
    @Optional()
    private readonly logger?: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const state = request as unknown as AuthorizationState;

    const metadata = this.reflector.getAllAndOverride<AuthorizeMetadata>(
      AUTHORIZE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!metadata) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (isPublic) return true;

      const isAuthenticatedOnly = this.reflector.getAllAndOverride<boolean>(
        AUTHENTICATED_ONLY_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      );

      if (isAuthenticatedOnly) {
        if (!request.principal) {
          throw new AppError(
            401,
            'UNAUTHENTICATED',
            'Se requiere autenticación para acceder a este recurso.',
          );
        }

        return true;
      }

      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'No tienes permisos para realizar esta acción.',
      );
    }

    const authenticated = request.principal;
    if (!authenticated) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'Se requiere autenticación para acceder a este recurso.',
      );
    }

    const establishmentId = readTenantId(
      request,
      state.tenant,
      metadata.resourceKind,
    );
    const principal = await this.permissions.resolve(
      authenticated.userId,
      establishmentId,
    );

    const decision = await this.decide(
      principal,
      metadata,
      buildResource(
        request,
        state.authorizationResource,
        metadata.resourceKind,
        establishmentId,
        authenticated.userId,
      ),
      request.id,
    );

    state.authz = decision;
    this.logDecision(request, decision, establishmentId);

    if (decision.decision === 'deny') {
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'No tienes permisos para realizar esta acción.',
      );
    }

    return true;
  }

  private async decide(
    principal: AuthorizedPrincipal,
    metadata: AuthorizeMetadata,
    resource: Record<string, unknown> | undefined,
    requestId: string | undefined,
  ): Promise<AuthorizationDecision> {
    const result = await this.runDecision(
      principal,
      metadata,
      resource,
      requestId,
    );

    return {
      resource: metadata.resourceKind,
      action: metadata.action,
      permission: metadata.permission,
      decision: result.allowed ? 'allow' : 'deny',
      ...(result.cerbosCallId
        ? { cerbosCallId: result.cerbosCallId }
        : {}),
      ...(result.requestId ? { requestId: result.requestId } : {}),
    };
  }

  private async runDecision(
    principal: AuthorizedPrincipal,
    metadata: AuthorizeMetadata,
    resource: Record<string, unknown> | undefined,
    requestId: string | undefined,
  ): Promise<AuthorizationDecisionResult> {
    if (typeof this.authorization.decide === 'function') {
      return this.authorization.decide(
        principal,
        metadata.resourceKind,
        metadata.action,
        resource,
        requestId,
      );
    }

    // Test doubles that only implement the original boolean contract still
    // work; they simply cannot contribute a `cerbosCallId`.
    return {
      allowed: await this.authorization.can(
        principal,
        metadata.resourceKind,
        metadata.action,
        resource,
        requestId,
      ),
    };
  }

  private logDecision(
    request: Request,
    decision: AuthorizationDecision,
    establishmentId: string | undefined,
  ): void {
    if (!this.logger) return;

    this.logger.raw.info(
      {
        event: 'authorization.decision',
        requestId: request.id,
        actorId: request.principal?.userId,
        establishmentId: establishmentId ?? null,
        route: (request.originalUrl ?? request.path ?? '').split('?')[0],
        resource: decision.resource,
        action: decision.action,
        permission: decision.permission,
        decision: decision.decision,
        cerbosCallId: decision.cerbosCallId ?? null,
        cerbosRequestId: decision.requestId ?? null,
      },
      'authorization_decision',
    );
  }
}

function readTenantId(
  request: Request,
  tenant: unknown,
  resourceKind: string,
): string | undefined {
  if (typeof tenant === 'string' && tenant.length > 0) {
    return tenant;
  }

  if (tenant && typeof tenant === 'object') {
    const record = tenant as Record<string, unknown>;
    const candidate = record.establishmentId ?? record.id;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  const params = request.params as Record<string, unknown> | undefined;

  if (typeof params?.establishmentId === 'string' && params.establishmentId) {
    return params.establishmentId;
  }

  // The path is the only authoritative tenant source (documented contract).
  // This covers `/establishments/:id/...` even if request.tenant is absent.
  const path = `${request.baseUrl ?? ''}${request.path ?? ''}`;
  if (
    path.includes('/establishments/') &&
    typeof params?.id === 'string' &&
    params.id
  ) {
    return params.id;
  }

  // Establishment resources are addressed by `:id` on the public/tenant route.
  if (resourceKind === 'establishment') {
    if (typeof params?.id === 'string' && params.id) {
      return params.id;
    }
  }

  return undefined;
}

function buildResource(
  request: Request,
  authorizationResource: unknown,
  resourceKind: string,
  establishmentId: string | undefined,
  userId: string,
): Record<string, unknown> | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const attrs: Record<string, unknown> = {};

  const paramId =
    (typeof params?.[`${resourceKind}Id`] === 'string'
      ? params[`${resourceKind}Id`]
      : undefined) ??
    (typeof params?.id === 'string' ? params.id : undefined);

  if (paramId) {
    attrs.id = paramId;
  }

  if (establishmentId) {
    attrs.establishmentId = establishmentId;
  }

  const explicit =
    authorizationResource && typeof authorizationResource === 'object'
      ? (authorizationResource as Record<string, unknown>)
      : undefined;

  // Self-service booking routes have no tenant: `/me` always scopes the
  // resource to the authenticated principal (Q16). On tenant routes
  // staff/owner must be able to act on other players' bookings, so this
  // default is deliberately restricted to the global booking context.
  if (
    resourceKind === 'booking' &&
    establishmentId === undefined &&
    !Object.prototype.hasOwnProperty.call(explicit ?? {}, 'playerId')
  ) {
    attrs.playerId = userId;
  }

  if (explicit) {
    // Explicit attributes win over path/tenant defaults and the self-booking
    // playerId fallback above.
    Object.assign(attrs, explicit);
  }

  return Object.keys(attrs).length > 0 ? attrs : undefined;
}
