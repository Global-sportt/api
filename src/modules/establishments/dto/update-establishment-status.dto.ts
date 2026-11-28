import { ApiProperty } from '@nestjs/swagger';
import { EstablishmentStatus } from '@prisma/client';
import { IsIn } from 'class-validator';

/**
 * Target states of the platform lifecycle endpoint.
 *
 * `pending` is intentionally excluded: it is a provisioning state, not a state
 * the platform can set through this route. The service repeats the check so
 * direct callers get the same 400 contract.
 */
export const ESTABLISHMENT_LIFECYCLE_STATUSES = [
  EstablishmentStatus.active,
  EstablishmentStatus.suspended,
] as const;

export type EstablishmentLifecycleStatus =
  (typeof ESTABLISHMENT_LIFECYCLE_STATUSES)[number];

export class UpdateEstablishmentStatusDto {
  @ApiProperty({
    enum: ESTABLISHMENT_LIFECYCLE_STATUSES,
    example: EstablishmentStatus.suspended,
    description: 'Estado destino: activo o suspendido.',
  })
  @IsIn(ESTABLISHMENT_LIFECYCLE_STATUSES)
  status!: EstablishmentLifecycleStatus;
}
