import { IsUUID } from 'class-validator';
import { CreateBookingDto } from './create-booking.dto';

/**
 * Tenant creation: staff/owner chooses the player. The establishment always
 * comes from the path; an `establishmentId` in the body is rejected by the
 * global whitelist pipe.
 */
export class CreateTenantBookingDto extends CreateBookingDto {
  @IsUUID()
  playerId!: string;
}
