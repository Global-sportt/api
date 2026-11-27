import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { normalizeEmail } from '../../../common/utils/crypto.util';

export class ForgotPasswordDto {
  @ApiProperty()
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  )
  @IsEmail({}, { message: 'El correo no es válido.' })
  @MaxLength(254)
  email!: string;
}
