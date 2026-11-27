import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class PublicAvailabilityQueryDto {
  @ApiProperty({
    description: 'Fecha local del establecimiento en formato YYYY-MM-DD.',
    example: '2026-11-27',
  })
  @Matches(DATE_ONLY_PATTERN, {
    message: 'date debe tener el formato YYYY-MM-DD.',
  })
  date!: string;

  @ApiPropertyOptional({
    description:
      'Cancha a consultar. Si se omite, se devuelven todas las canchas activas.',
  })
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({
    description: 'Fecha local del establecimiento en formato YYYY-MM-DD.',
    example: '2026-11-27',
  })
  @Matches(DATE_ONLY_PATTERN, {
    message: 'date debe tener el formato YYYY-MM-DD.',
  })
  date!: string;
}
