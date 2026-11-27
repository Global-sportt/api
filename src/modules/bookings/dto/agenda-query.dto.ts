import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AgendaQueryDto {
  @ApiProperty({
    description:
      'Fecha local del establecimiento en formato YYYY-MM-DD. Define las fronteras del día en la zona horaria del establecimiento.',
    example: '2026-11-27',
  })
  @Matches(DATE_ONLY_PATTERN, {
    message: 'date debe tener el formato YYYY-MM-DD.',
  })
  date!: string;
}
