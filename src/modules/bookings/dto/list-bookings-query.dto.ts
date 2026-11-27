import { BookingStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

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
}
