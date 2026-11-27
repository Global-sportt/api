import { ApiPropertyOptional } from '@nestjs/swagger';
import { SpaceStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListSpacesQueryDto {
  @ApiPropertyOptional({
    enum: SpaceStatus,
    description: 'Filtra por estado de la cancha.',
  })
  @IsOptional()
  @IsEnum(SpaceStatus)
  status?: SpaceStatus;

  @ApiPropertyOptional({
    example: 'futbol',
    description: 'Filtra por deporte, sin distinguir mayúsculas.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  sport?: string;
}
