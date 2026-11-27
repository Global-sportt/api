import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class OAuthStartQueryDto {
  @ApiPropertyOptional({
    description: 'Ruta relativa a la que volver después del login.',
    example: '/auth/callback',
    default: '/auth/callback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  return_to?: string;
}
