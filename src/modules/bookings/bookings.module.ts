import { Module } from '@nestjs/common';
import { AUTHZ_PERMISSION_RESOLVER } from '../../common/authz/authorization.types';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { PermissionResolver } from '../../common/authz/permission-resolver.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { SpacesModule } from '../spaces/spaces.module';
import { BookingNotificationsService } from './booking-notifications.service';
import { BookingsExpiryService } from './bookings-expiry.service';
import {
  BookingsController,
  EstablishmentBookingsController,
  MyBookingsController,
} from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  imports: [AuthzModule, SpacesModule, AuthModule],
  controllers: [
    BookingsController,
    MyBookingsController,
    EstablishmentBookingsController,
  ],
  providers: [
    BookingsService,
    BookingNotificationsService,
    BookingsExpiryService,
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
