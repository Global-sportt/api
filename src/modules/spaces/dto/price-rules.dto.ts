import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Hard cap for the complete price grid of one space. */
export const MAX_PRICE_RULES = 100;

/** One trillion minor units; keeps the amount inside the JS safe integer range. */
export const MAX_PRICE_AMOUNT_MINOR = 1_000_000_000_000;

export const PRICE_RULE_CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export class PriceRuleDto {
  @ApiPropertyOptional({
    description:
      'Día de la semana, 0 = domingo … 6 = sábado. Se omite para aplicar todos los días.',
    minimum: 0,
    maximum: 6,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number | null;

  @ApiProperty({
    description: 'Minuto local de inicio de la franja, 0 = 00:00.',
    minimum: 0,
    maximum: 1439,
    example: 600,
  })
  @IsInt()
  @Min(0)
  @Max(1439)
  startsAtMinutes!: number;

  @ApiProperty({
    description:
      'Minuto local de fin de la franja, mayor que startsAtMinutes. 1440 = 24:00.',
    minimum: 1,
    maximum: 1440,
    example: 660,
  })
  @IsInt()
  @Min(1)
  @Max(1440)
  endsAtMinutes!: number;

  @ApiProperty({
    description: 'Precio de la franja en unidades menores, mayor que 0.',
    minimum: 1,
    maximum: MAX_PRICE_AMOUNT_MINOR,
    example: 18000,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_AMOUNT_MINOR)
  amountMinor!: number;

  @ApiPropertyOptional({
    description:
      'Desempate entre reglas aplicables. A mayor prioridad, gana la regla. 0-100.',
    minimum: 0,
    maximum: 100,
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({
    description:
      'Moneda ISO de 3 letras. Debe coincidir con la del establecimiento; si se omite se usa la del establecimiento.',
    example: 'COP',
  })
  @IsOptional()
  @IsString()
  @Matches(PRICE_RULE_CURRENCY_PATTERN, {
    message: 'currency debe ser un código ISO de 3 letras.',
  })
  currency?: string;
}

export class ReplacePriceRulesDto {
  @ApiProperty({
    type: [PriceRuleDto],
    maxItems: MAX_PRICE_RULES,
    description:
      'Grilla completa de precios. Reemplaza todas las reglas existentes de la cancha.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_PRICE_RULES)
  @ValidateNested({ each: true })
  @Type(() => PriceRuleDto)
  rules!: PriceRuleDto[];
}
