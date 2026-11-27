import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SpaceStatus } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const SPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateSpaceDto {
  @ApiProperty({ example: 'Cancha Norte', minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  name!: string;

  @ApiProperty({
    example: 'futbol',
    minLength: 1,
    maxLength: 40,
    description: 'Tipo de deporte de la cancha. Es obligatorio.',
  })
  @IsString()
  @Length(1, 40)
  sport!: string;

  @ApiPropertyOptional({
    example: 'cancha-norte',
    description:
      'Slug único por establecimiento. Si se omite, se genera desde el nombre.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  @Matches(SPACE_SLUG_PATTERN, {
    message:
      'El slug solo admite minúsculas, números y guiones simples entre palabras.',
  })
  slug?: string;

  @ApiPropertyOptional({
    example: 60,
    minimum: 15,
    maximum: 240,
    default: 60,
  })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  slotMinutes?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 120, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({
    example: 4500000,
    minimum: 1,
    description:
      'Tarifa fija por hora en unidades menores (COP). Entero mayor que cero.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  basePriceMinor?: number;

  @ApiPropertyOptional({ enum: SpaceStatus, default: SpaceStatus.active })
  @IsOptional()
  @IsEnum(SpaceStatus)
  status?: SpaceStatus;
}
