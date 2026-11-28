import { Module } from '@nestjs/common';
import { AUTHZ_PERMISSION_RESOLVER } from '../../common/authz/authorization.types';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { PermissionResolver } from '../../common/authz/permission-resolver.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { SpacesModule } from '../spaces/spaces.module';
import { BookingsExpiryService } from './bookings-expiry.service';
import {
  BookingsController,
  EstablishmentBookingsController,
  MyBookingsController,
} from './bookings.controller';
import { BookingsService } from './bookings.service';
import { DayCloseController } from './day-close.controller';
import { DayCloseService } from './day-close.service';

@Module({
  imports: [AuthzModule, SpacesModule],
  controllers: [
    BookingsController,
    MyBookingsController,
    EstablishmentBookingsController,
    DayCloseController,
  ],
  providers: [
    BookingsService,
    BookingsExpiryService,
    DayCloseService,
    TenantGuard,
    AuthorizationGuard,
    {
      provide: AUTHZ_PERMISSION_RESOLVER,
      useExisting: PermissionResolver,
    },
  ],
  exports: [BookingsService, BookingsExpiryService],
})
export class BookingsModule {}
