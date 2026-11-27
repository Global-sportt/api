import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { PublicUser } from '../../users/users.service';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: ['active', 'suspended', 'deleted'] })
  status!: string;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ nullable: true })
  displayName!: string | null;

  @ApiProperty({ nullable: true })
  avatarUrl!: string | null;

  @ApiProperty({ example: 'es-CO' })
  locale!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(user: PublicUser): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerified: user.emailVerified,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      createdAt: user.createdAt,
    };
  }
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ example: 900 })
  expiresIn!: number;

  @ApiProperty({ format: 'date-time' })
  accessTokenExpiresAt!: string;

  @ApiPropertyOptional({
    description: 'Solo se devuelve a clientes móviles/API.',
  })
  refreshToken?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  refreshExpiresAt?: string;

  @ApiPropertyOptional({
    description: 'Token de doble envío para peticiones con cookie.',
  })
  csrfToken?: string;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

export class MessageResponseDto {
  @ApiProperty()
  message!: string;
}

export class RegisterResponseDto extends MessageResponseDto {
  @ApiPropertyOptional({
    description:
      'Solo en desarrollo con AUTH_DEV_EXPOSE_TOKENS=true. Nunca en producción.',
    type: Object,
  })
  dev?: {
    verificationToken: string;
  };
}
