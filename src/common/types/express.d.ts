import type { AppRole } from '../auth/roles';

export type AuthErrorCode = 'invalid_token' | 'expired_token';

export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  role: AppRole;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      startedAt: number;
      ipHash?: string;
      principal?: AuthenticatedPrincipal;
      authError?: AuthErrorCode;
    }
  }
}

export {};
