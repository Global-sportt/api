/**
 * Authorization contract shared by the PEP (guard/service), the permission
 * resolver and the Cerbos PDP adapter.
 *
 * The permission catalogue itself lives in PostgreSQL; this module only
 * describes the shape of a resolved principal and the decisions we consume.
 */

export type PermissionScope = 'own' | 'establishment' | 'platform';

export type PermissionMap = Record<string, PermissionScope>;

export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';

/**
 * Principal resolved for a single tenant context. It must never contain PII.
 *
 * `permissions` are resolved for the requested tenant only (global context or
 * one establishment), never as the union of every membership.
 */
export interface AuthorizedPrincipal {
  userId: string;
  permissions: PermissionMap;
  establishmentId?: string | null;
  membershipStatus?: MembershipStatus;
  isPlatformAdmin: boolean;
}

/**
 * Tenant context attached to the request by the tenant layer. Both property
 * names are accepted because the tenant guard may expose either one.
 */
export interface TenantContext {
  establishmentId?: string | null;
  id?: string | null;
}

/** Decision metadata attached to an allowed request (`request.authz`). */
export interface AuthorizationDecision {
  resource: string;
  action: string;
  permission: string;
}

/**
 * Minimal resolver contract. A2a owns the Prisma-backed implementation; the
 * guard only depends on this interface so both changes can land independently.
 *
 * `establishmentId` is `undefined` for global contexts (`/me`, `/admin`).
 */
export interface PermissionResolver {
  resolve(
    userId: string,
    establishmentId?: string | null,
  ): Promise<AuthorizedPrincipal>;
}

/**
 * Port used by the guard. The Cerbos-backed implementation lives in
 * `authorization.service.ts`; tests provide a fake.
 */
export interface AuthorizationService {
  can(
    principal: AuthorizedPrincipal,
    resourceKind: string,
    action: string,
    resource?: Record<string, unknown>,
  ): Promise<boolean>;

  plan(
    principal: AuthorizedPrincipal,
    resourceKind: string,
    action: string,
  ): Promise<QueryPlan>;
}

/** DI tokens (symbols avoid collisions with Nest's class-based providers). */
export const AUTHORIZATION_SERVICE = Symbol('AUTHORIZATION_SERVICE');
export const AUTHZ_PERMISSION_RESOLVER = Symbol('AUTHZ_PERMISSION_RESOLVER');

/**
 * Cerbos query plan kinds. Kept as a string union so the client can be used
 * without importing the ESM-only SDK into this CommonJS build.
 */
export const PLAN_KIND = {
  ALWAYS_ALLOWED: 'KIND_ALWAYS_ALLOWED',
  ALWAYS_DENIED: 'KIND_ALWAYS_DENIED',
  CONDITIONAL: 'KIND_CONDITIONAL',
} as const;

export type PlanKind = (typeof PLAN_KIND)[keyof typeof PLAN_KIND];

export interface QueryPlanBase {
  kind: PlanKind;
  cerbosCallId?: string;
  requestId?: string;
  validationErrors?: readonly unknown[];
  metadata?: unknown;
}

export interface ConditionalQueryPlan extends QueryPlanBase {
  kind: typeof PLAN_KIND.CONDITIONAL;
  condition: unknown;
}

export interface UnconditionalQueryPlan extends QueryPlanBase {
  kind:
    | typeof PLAN_KIND.ALWAYS_ALLOWED
    | typeof PLAN_KIND.ALWAYS_DENIED;
}

export type QueryPlan = ConditionalQueryPlan | UnconditionalQueryPlan;
