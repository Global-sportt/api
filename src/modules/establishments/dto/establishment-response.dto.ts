import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EstablishmentStatus } from '@prisma/client';

/** Documented response of the tenant establishment endpoints. */
export class EstablishmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Cancha Norte' })
  name!: string;

  @ApiProperty({ example: 'cancha-norte' })
  slug!: string;

  @ApiProperty({ example: 'America/Bogota' })
  timezone!: string;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiProperty({ enum: EstablishmentStatus })
  status!: EstablishmentStatus;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  address!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 40 })
  contactPhone!: string | null;

  @ApiPropertyOptional({ nullable: true })
  contactEmail!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  cancellationPolicy!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  usagePolicy!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  rules!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** Documented response of `GET /public/establishments/:slug`. */
export class PublicEstablishmentResponseDto {
  @ApiProperty({ example: 'Cancha Norte' })
  name!: string;

  @ApiProperty({ example: 'cancha-norte' })
  slug!: string;

  @ApiProperty({ example: 'America/Bogota' })
  timezone!: string;

  @ApiProperty({ example: 'COP' })
  currency!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  address!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 40 })
  contactPhone!: string | null;

  @ApiPropertyOptional({ nullable: true })
  contactEmail!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  cancellationPolicy!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  usagePolicy!: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 4000 })
  rules!: string | null;
}
