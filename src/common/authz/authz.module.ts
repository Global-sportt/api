import { Module } from '@nestjs/common';
import { PermissionResolver } from './permission-resolver.service';

/**
 * Base de autorización (permisos efectivos por tenant).
 *
 * Aún no se importa en AppModule: A0 integrará este módulo junto con el guard
 * de autorización y el cliente Cerbos de A2b.
 */
@Module({
  providers: [PermissionResolver],
  exports: [PermissionResolver],
})
export class AuthzModule {}
