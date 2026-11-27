import { Module } from '@nestjs/common';
import { AUTHZ_PERMISSION_RESOLVER } from '../../common/authz/authorization.types';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { PermissionResolver } from '../../common/authz/permission-resolver.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  AdminEstablishmentsController,
  EstablishmentsController,
  MembershipsController,
  MyEstablishmentsController,
  PublicEstablishmentsController,
} from './establishments.controller';
import { EstablishmentsService } from './establishments.service';

/**
 * Establishments, tenant memberships (T4) and the public establishment profile.
 *
 * Integration note for A0: `AuthorizationGuard` depends on the
 * `AUTHORIZATION_SERVICE` token (Cerbos adapter), which is not provided by
 * this module yet. Wire it globally or import the authz module that exports
 * it before adding `EstablishmentsModule` to `AppModule`. The resolver token
 * is aliased locally so both guards share the same `PermissionResolver`.
 */
@Module({
  imports: [AuthzModule],
  controllers: [
    AdminEstablishmentsController,
    MyEstablishmentsController,
    EstablishmentsController,
    MembershipsController,
    PublicEstablishmentsController,
  ],
  providers: [
    EstablishmentsService,
    TenantGuard,
    AuthorizationGuard,
    {
      provide: AUTHZ_PERMISSION_RESOLVER,
      useExisting: PermissionResolver,
    },
  ],
  exports: [EstablishmentsService, TenantGuard],
})
export class EstablishmentsModule {}
