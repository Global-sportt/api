import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { ReplacePriceRulesDto } from './dto/price-rules.dto';
import {
  PriceRulesResponse,
  PriceRulesService,
} from './price-rules.service';

/**
 * Price grid of one space, addressed through its establishment so TenantGuard
 * resolves the tenant from the path and a space from another establishment
 * responds 404 before any write (cross-tenant isolation).
 */
@ApiTags('price-rules')
@ApiBearerAuth()
@Controller('establishments/:establishmentId/spaces/:spaceId')
@UseGuards(TenantGuard, AuthorizationGuard)
export class PriceRulesController {
  constructor(private readonly priceRules: PriceRulesService) {}

  @Get('price-rules')
  @Authorize('price', 'read')
  @ApiOperation({
    summary: 'Consultar las reglas de precio de una cancha',
    description:
      'Reglas ordenadas por precedencia: mayor prioridad, inicio más temprano, fin más temprano y regla específica del día.',
  })
  @ApiResponse({ status: 200, description: 'Reglas de precio de la cancha.' })
  @ApiResponse({ status: 403, description: 'Sin permiso price:read.' })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento o cancha no encontrados.',
  })
  getPriceRules(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
  ): Promise<PriceRulesResponse> {
    return this.priceRules.getPriceRules(establishmentId, spaceId);
  }

  @Put('price-rules')
  @Authorize('price', 'manage')
  @ApiOperation({
    summary: 'Reemplazar las reglas de precio de una cancha',
    description:
      'Reemplaza todas las reglas en una transacción. Rechaza franjas invertidas, monedas distintas a la del establecimiento y cruces con la misma prioridad y día (dayOfWeek nulo aplica todos los días).',
  })
  @ApiResponse({ status: 200, description: 'Reglas reemplazadas.' })
  @ApiResponse({
    status: 400,
    description: 'Reglas inválidas, moneda incorrecta o cruces ambiguos.',
  })
  @ApiResponse({ status: 403, description: 'Sin permiso price:manage.' })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento o cancha no encontrados.',
  })
  replacePriceRules(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Body() dto: ReplacePriceRulesDto,
  ): Promise<PriceRulesResponse> {
    return this.priceRules.replacePriceRules(establishmentId, spaceId, dto);
  }
}
