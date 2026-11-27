import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClientType } from '../auth.constants';

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Solo para clientes móviles/API. La web usa la cookie httpOnly.',
  })
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken?: string;

  @ApiPropertyOptional({ enum: ['web', 'mobile'] })
  @IsOptional()
  @IsIn(['web', 'mobile'])
  client?: ClientType;
}
