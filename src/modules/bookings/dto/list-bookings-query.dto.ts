import { BookingStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID, Matches } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ListBookingsQueryDto {
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /**
   * Optional narrowing filter. On `/me` it is ANDed with the forced
   * `playerId = principal.id`, so it can only return an empty list for another
   * player, never widen the scope.
   */
  @IsOptional()
  @IsUUID()
  playerId?: string;

  /**
   * Optional local-day filter (YYYY-MM-DD). Only the tenant listing
   * (`GET /establishments/:id/bookings`) applies it, using the establishment
   * timezone. `/me` ignores it on purpose: a player can have bookings in
   * several timezones, so there is no single local day to filter by.
   */
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, {
    message: 'date debe tener el formato YYYY-MM-DD.',
  })
  date?: string;
}
