import { IsDateString, Matches } from 'class-validator';

/**
 * Fecha de calendario local de la sede. No se acepta un instante ISO completo:
 * el día se resuelve con la zona horaria del establecimiento, no con la del
 * servidor ni con la del cliente.
 */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CloseDayDto {
  @Matches(DATE_ONLY_PATTERN, {
    message: 'date debe tener formato YYYY-MM-DD.',
  })
  @IsDateString({ strict: true, strictSeparator: true })
  date!: string;
}

export class ListDayClosesQueryDto {
  @Matches(DATE_ONLY_PATTERN, {
    message: 'from debe tener formato YYYY-MM-DD.',
  })
  @IsDateString({ strict: true, strictSeparator: true })
  from!: string;

  @Matches(DATE_ONLY_PATTERN, {
    message: 'to debe tener formato YYYY-MM-DD.',
  })
  @IsDateString({ strict: true, strictSeparator: true })
  to!: string;
}
