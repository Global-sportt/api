import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Hard cap for the whole weekly grid of one space. */
export const MAX_OPERATING_HOURS = 50;

/** Both ends are inclusive: 366 days covers a full leap-year window. */
export const MAX_EXCEPTION_RANGE_DAYS = 366;

export class OperatingHourDto {
  @ApiProperty({
    description: 'Día de la semana, 0 = domingo … 6 = sábado.',
    minimum: 0,
    maximum: 6,
    example: 1,
  })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({
    description: 'Minuto local de apertura, 0 = 00:00 … 1439 = 23:59.',
    minimum: 0,
    maximum: 1439,
    example: 540,
  })
  @IsInt()
  @Min(0)
  @Max(1439)
  opensAtMinutes!: number;

  @ApiProperty({
    description: 'Minuto local de cierre, 1 = 00:01 … 1440 = 24:00.',
    minimum: 1,
    maximum: 1440,
    example: 720,
  })
  @IsInt()
  @Min(1)
  @Max(1440)
  closesAtMinutes!: number;
}

export class ReplaceOperatingHoursDto {
  @ApiProperty({
    type: [OperatingHourDto],
    maxItems: MAX_OPERATING_HOURS,
    description:
      'Grilla semanal completa. Reemplaza todas las franjas existentes de la cancha.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_OPERATING_HOURS)
  @ValidateNested({ each: true })
  @Type(() => OperatingHourDto)
  hours!: OperatingHourDto[];
}

export class ScheduleExceptionsQueryDto {
  @ApiProperty({
    description: 'Primera fecha del rango, inclusive (YYYY-MM-DD).',
    example: '2026-12-01',
  })
  @Matches(DATE_ONLY_PATTERN, {
    message: 'from debe tener el formato YYYY-MM-DD.',
  })
  from!: string;

  @ApiProperty({
    description:
      'Última fecha del rango, inclusive (YYYY-MM-DD). Máximo 366 días.',
    example: '2026-12-31',
  })
  @Matches(DATE_ONLY_PATTERN, {
    message: 'to debe tener el formato YYYY-MM-DD.',
  })
  to!: string;
}

export class UpsertScheduleExceptionDto {
  @ApiProperty({
    description:
      'true cierra la fecha; false define un horario alterno para esa fecha.',
    example: false,
  })
  @IsBoolean()
  isClosed!: boolean;

  @ApiPropertyOptional({
    description:
      'Minuto local de apertura. Obligatorio cuando isClosed es false.',
    minimum: 0,
    maximum: 1439,
    example: 600,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  opensAtMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Minuto local de cierre, mayor que opensAtMinutes. Obligatorio cuando isClosed es false.',
    minimum: 1,
    maximum: 1440,
    example: 840,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  closesAtMinutes?: number;

  @ApiPropertyOptional({
    description: 'Motivo visible para el equipo del establecimiento.',
    maxLength: 200,
    example: 'Mantenimiento programado',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
