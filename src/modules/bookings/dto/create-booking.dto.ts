import { PaymentMethod } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsUUID } from 'class-validator';

export class CreateBookingDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Cancha que se quiere reservar.',
  })
  @IsUUID()
  spaceId!: string;

  @ApiProperty({
    description: 'Método de pago elegido por el jugador.',
    enum: PaymentMethod,
    enumName: 'PaymentMethod',
    example: PaymentMethod.cash,
  })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiProperty({
    format: 'date-time',
    description: 'Inicio de la franja (ISO-8601).',
    example: '2026-11-28T14:00:00.000Z',
  })
  @IsISO8601({ strict: true })
  startsAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Fin de la franja (ISO-8601).',
    example: '2026-11-28T15:00:00.000Z',
  })
  @IsISO8601({ strict: true })
  endsAt!: string;
}
