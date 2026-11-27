import { SetMetadata } from '@nestjs/common';

export const AUTHORIZE_METADATA_KEY = 'authz:authorize';

export interface AuthorizeMetadata {
  /** Cerbos resource kind, e.g. `booking`. */
  resourceKind: string;
  /** Cerbos action, e.g. `read`. */
  action: string;
  /** Full catalogue code, e.g. `booking:read`. */
  permission: string;
}

/**
 * Declares the Cerbos check required by a route.
 *
 * This only records metadata. Enforcement (including the fail-closed behaviour
 * for routes without metadata) is done by `AuthorizationGuard`, which is not
 * registered globally yet.
 */
export const Authorize = (
  resourceKind: string,
  action: string,
): MethodDecorator & ClassDecorator => {
  const kind = typeof resourceKind === 'string' ? resourceKind.trim() : '';
  const verb = typeof action === 'string' ? action.trim() : '';

  if (!kind || !verb) {
    throw new Error(
      '@Authorize requires a non-empty resource kind and action.',
    );
  }

  const metadata: AuthorizeMetadata = {
    resourceKind: kind,
    action: verb,
    permission: `${kind}:${verb}`,
  };

  return SetMetadata(AUTHORIZE_METADATA_KEY, metadata);
};
