import type { MembershipStatus } from '@prisma/client';

export type AuthErrorCode = 'invalid_token' | 'expired_token';

export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
}

/**
 * Tenant context attached by `TenantGuard` after validating the establishment
 * and the caller's membership. Only tenant routes (`/establishments/:id/...`)
 * carry it; `/me` and `/admin` routes never do.
 */
export interface TenantRequestContext {
  establishmentId: string;
  membershipId?: string;
  status?: MembershipStatus;
  isPlatformAdmin: boolean;
  /** True when a platform-admin enters a tenant without an active membership. */
  auditBypass: boolean;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      startedAt: number;
      ipHash?: string;
      principal?: AuthenticatedPrincipal;
      authError?: AuthErrorCode;
      tenant?: TenantRequestContext;
    }
  }
}

export {};
