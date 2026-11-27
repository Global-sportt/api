import { ApiPropertyOptional } from '@nestjs/swagger';
import { SpaceStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * All fields are optional but the service requires at least one change. The
 * slug is deliberately immutable: reservations and public links already point
 * to it.
 */
export class UpdateSpaceDto {
  @ApiPropertyOptional({ example: 'Cancha Norte', minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ example: 'futbol', minLength: 1, maxLength: 40 })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  sport?: string;

  @ApiPropertyOptional({ example: 60, minimum: 15, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  slotMinutes?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({
    example: 4500000,
    minimum: 1,
    description: 'Tarifa fija por hora en unidades menores (COP).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  basePriceMinor?: number;

  @ApiPropertyOptional({ enum: SpaceStatus })
  @IsOptional()
  @IsEnum(SpaceStatus)
  status?: SpaceStatus;
}
