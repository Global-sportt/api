import { Module } from '@nestjs/common';
import { AUTHZ_PERMISSION_RESOLVER } from '../../common/authz/authorization.types';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { PermissionResolver } from '../../common/authz/permission-resolver.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Platform dashboard (reporting). The resolver token is aliased locally so the
 * guard and any future tenant guard share the same `PermissionResolver`, as
 * the neighbouring domain modules do.
 */
@Module({
  imports: [AuthzModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    AuthorizationGuard,
    {
      provide: AUTHZ_PERMISSION_RESOLVER,
      useExisting: PermissionResolver,
    },
  ],
  exports: [DashboardService],
})
export class DashboardModule {}
