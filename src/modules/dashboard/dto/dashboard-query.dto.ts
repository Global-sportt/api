import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Period selector for the platform dashboard.
 *
 * Both bounds are inclusive local calendar dates (`YYYY-MM-DD`) interpreted in
 * `America/Bogota`. The service validates real calendar dates, `from <= to`
 * and the 366-day ceiling; the regex only rejects malformed values early.
 */
export class DashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-11-01',
    description:
      'Fecha inicial inclusive (YYYY-MM-DD, America/Bogota). Por defecto, 29 días antes de `to`.',
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, {
    message: 'from debe tener formato YYYY-MM-DD.',
  })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description:
      'Fecha final inclusive (YYYY-MM-DD, America/Bogota). Por defecto, el día local actual.',
  })
  @IsOptional()
  @Matches(DATE_ONLY_PATTERN, {
    message: 'to debe tener formato YYYY-MM-DD.',
  })
  to?: string;
}
