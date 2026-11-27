import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AUTHORIZATION_SERVICE, AUTHZ_PERMISSION_RESOLVER } from './authorization.types';
import { CerbosAuthorizationService } from './authorization.service';
import { CerbosClient } from './cerbos.client';
import { PermissionResolver } from './permission-resolver.service';
import { RoutePolicyRegistry } from './route-policy.registry';

/**
 * Base de autorización.
 *
 * Provee:
 * - `PermissionResolver`: permisos efectivos por usuario/tenant.
 * - `CerbosClient`: transporte HTTP al PDP local.
 * - `AUTHORIZATION_SERVICE`: fachada que usa el guard.
 * - `AUTHZ_PERMISSION_RESOLVER`: token que consumen los guards.
 *
 * Los módulos de dominio importan este módulo y usan `@UseGuards` por
 * controlador; el guard no se registra globalmente para no romper rutas de
 * autenticación que solo requieren sesión. `RoutePolicyRegistry` valida al
 * arranque que toda ruta declare `@Authorize`, `@Public` o
 * `@AuthenticatedOnly`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    RoutePolicyRegistry,
    PermissionResolver,
    CerbosClient,
    CerbosAuthorizationService,
    {
      provide: AUTHORIZATION_SERVICE,
      useExisting: CerbosAuthorizationService,
    },
    {
      provide: AUTHZ_PERMISSION_RESOLVER,
      useExisting: PermissionResolver,
    },
  ],
  exports: [
    RoutePolicyRegistry,
    PermissionResolver,
    CerbosClient,
    CerbosAuthorizationService,
    AUTHORIZATION_SERVICE,
    AUTHZ_PERMISSION_RESOLVER,
  ],
})
export class AuthzModule {}
