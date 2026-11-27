import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_ONLY_METADATA_KEY = 'authz:authenticatedOnly';

/**
 * Explicitly marks a private route that only requires a valid access token.
 *
 * `JwtAuthGuard` remains global and keeps enforcing authentication; this
 * marker exists so the startup route registry can distinguish an intentional
 * authentication-only route (identity/self-service) from a route that forgot
 * `@Authorize`.
 */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_METADATA_KEY, true);
