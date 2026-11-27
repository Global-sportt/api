import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsTimeZone,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Partial update of the tenant establishment profile.
 *
 * Every field is optional, but the service rejects an empty body. `null`
 * clears the nullable fields (contact data and policies); the core fields
 * (`name`, `timezone`, `currency`) cannot be nulled.
 */
export class UpdateEstablishmentDto {
  @ApiPropertyOptional({
    example: 'Cancha Norte',
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @ApiPropertyOptional({
    example: 'America/Bogota',
    description: 'Zona IANA válida.',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({
    example: 'COP',
    description: 'Código ISO de 3 letras en mayúsculas.',
    minLength: 3,
    maxLength: 3,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser un código ISO de 3 letras en mayúsculas.',
  })
  currency?: string;

  @ApiPropertyOptional({
    example: 'Calle 123 #45-67, Bogotá',
    maxLength: 300,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({
    example: '+57 601 555 0101',
    maxLength: 40,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @ApiPropertyOptional({
    example: 'contacto@cancha-norte.example',
    nullable: true,
  })
  @IsOptional()
  @IsEmail()
  contactEmail?: string | null;

  @ApiPropertyOptional({
    example: 'Cancelación sin costo hasta 24 horas antes.',
    maxLength: 4000,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cancellationPolicy?: string | null;

  @ApiPropertyOptional({
    example: 'Uso exclusivo para actividades deportivas.',
    maxLength: 4000,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  usagePolicy?: string | null;

  @ApiPropertyOptional({
    example: 'Prohibido ingresar con alimentos.',
    maxLength: 4000,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rules?: string | null;
}
