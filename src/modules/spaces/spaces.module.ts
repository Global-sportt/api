import { Module } from '@nestjs/common';
import { AUTHZ_PERMISSION_RESOLVER } from '../../common/authz/authorization.types';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { PermissionResolver } from '../../common/authz/permission-resolver.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PriceRulesController } from './price-rules.controller';
import { PriceRulesService } from './price-rules.service';
import { PublicSpacesController, SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';
import { SlotsService } from './slots.service';

/**
 * T5 — canchas, horarios, excepciones y precios.
 *
 * AppModule is intentionally not touched; A0 integrates this module together
 * with the global JwtAuthGuard/Cerbos provider. The resolver token is aliased
 * locally so TenantGuard and AuthorizationGuard share the same resolver, as
 * EstablishmentsModule does.
 */
@Module({
  imports: [AuthzModule],
  controllers: [PublicSpacesController, SpacesController, PriceRulesController],
  providers: [
    SpacesService,
    SlotsService,
    PriceRulesService,
    TenantGuard,
    AuthorizationGuard,
    {
      provide: AUTHZ_PERMISSION_RESOLVER,
      useExisting: PermissionResolver,
    },
  ],
  exports: [SpacesService, SlotsService],
})
export class SpacesModule {}
