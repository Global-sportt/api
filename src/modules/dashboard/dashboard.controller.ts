import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardService, type PlatformDashboardResponse } from './dashboard.service';

/**
 * Platform-wide dashboard. It is not tenant-scoped: the resource carries no
 * `establishmentId`, so the Cerbos `report:read` check only allows the
 * `platform` scope. An owner/staff member (scope `establishment`) receives 403
 * because the global permission context never includes tenant grants.
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('admin/dashboard')
@UseGuards(AuthorizationGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Authorize('report', 'read')
  @ApiOperation({
    summary: 'Tablero de toda la plataforma',
    description:
      'Agregados de sedes, usuarios y reservas para el rol de plataforma. Las fechas `from` y `to` son días locales en America/Bogota e inclusivos; por defecto, los últimos 30 días incluido hoy. Máximo 366 días.',
  })
  @ApiOkResponse({ description: 'Agregados del periodo solicitado.' })
  @ApiResponse({ status: 400, description: 'Rango de fechas inválido.' })
  @ApiResponse({ status: 403, description: 'Sin permiso report:read de plataforma.' })
  getDashboard(
    @Query() query: DashboardQueryDto,
  ): Promise<PlatformDashboardResponse> {
    return this.dashboard.getPlatformDashboard(query);
  }
}
