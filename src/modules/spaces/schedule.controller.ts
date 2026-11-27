import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  ReplaceOperatingHoursDto,
  ScheduleExceptionsQueryDto,
  UpsertScheduleExceptionDto,
} from './dto/schedule.dto';
import {
  OperatingHoursResponse,
  ScheduleExceptionResponse,
  ScheduleExceptionsResponse,
  ScheduleService,
} from './schedule.service';

/**
 * Weekly operating grid and date exceptions of one space.
 *
 * The space is always addressed through its establishment so TenantGuard
 * resolves the tenant from the path and a space from another establishment
 * responds 404 before any write (cross-tenant isolation).
 */
@ApiTags('schedule')
@ApiBearerAuth()
@Controller('establishments/:establishmentId/spaces/:spaceId')
@UseGuards(TenantGuard, AuthorizationGuard)
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Get('operating-hours')
  @Authorize('schedule', 'read')
  @ApiOperation({
    summary: 'Consultar la grilla semanal de horarios de una cancha',
  })
  @ApiResponse({ status: 200, description: 'Franjas ordenadas por día y apertura.' })
  @ApiResponse({ status: 403, description: 'Sin permiso schedule:read.' })
  @ApiResponse({ status: 404, description: 'Cancha no encontrada en el establecimiento.' })
  getOperatingHours(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
  ): Promise<OperatingHoursResponse> {
    return this.schedule.getOperatingHours(establishmentId, spaceId);
  }

  @Put('operating-hours')
  @Authorize('schedule', 'manage')
  @ApiOperation({
    summary: 'Reemplazar la grilla semanal de horarios de una cancha',
    description:
      'Reemplaza todas las franjas en una transacción. Rechaza franjas que terminan antes de iniciar, duplicados y cruces del mismo día.',
  })
  @ApiResponse({ status: 200, description: 'Grilla reemplazada.' })
  @ApiResponse({ status: 400, description: 'Franjas inválidas o en conflicto.' })
  @ApiResponse({ status: 403, description: 'Sin permiso schedule:manage.' })
  @ApiResponse({ status: 404, description: 'Cancha no encontrada en el establecimiento.' })
  replaceOperatingHours(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Body() dto: ReplaceOperatingHoursDto,
  ): Promise<OperatingHoursResponse> {
    return this.schedule.replaceOperatingHours(establishmentId, spaceId, dto);
  }

  @Get('schedule-exceptions')
  @Authorize('schedule', 'read')
  @ApiOperation({
    summary: 'Listar las excepciones de horario de una cancha',
    description: 'Rango inclusivo de fechas locales, máximo 366 días.',
  })
  @ApiResponse({ status: 200, description: 'Excepciones ordenadas por fecha.' })
  @ApiResponse({ status: 400, description: 'Rango de fechas inválido.' })
  @ApiResponse({ status: 403, description: 'Sin permiso schedule:read.' })
  @ApiResponse({ status: 404, description: 'Cancha no encontrada en el establecimiento.' })
  listExceptions(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Query() query: ScheduleExceptionsQueryDto,
  ): Promise<ScheduleExceptionsResponse> {
    return this.schedule.listExceptions(establishmentId, spaceId, query);
  }

  @Put('schedule-exceptions/:date')
  @Authorize('schedule', 'manage')
  @ApiOperation({
    summary: 'Crear o actualizar la excepción de horario de una fecha',
    description:
      'isClosed=true cierra el día y no admite horas. isClosed=false exige un horario completo con cierre posterior a la apertura.',
  })
  @ApiResponse({ status: 200, description: 'Excepción creada o actualizada.' })
  @ApiResponse({ status: 400, description: 'Fecha u horas inválidas.' })
  @ApiResponse({ status: 403, description: 'Sin permiso schedule:manage.' })
  @ApiResponse({ status: 404, description: 'Cancha no encontrada en el establecimiento.' })
  upsertException(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Param('date') date: string,
    @Body() dto: UpsertScheduleExceptionDto,
  ): Promise<ScheduleExceptionResponse> {
    return this.schedule.upsertException(establishmentId, spaceId, date, dto);
  }

  @Delete('schedule-exceptions/:date')
  @Authorize('schedule', 'manage')
  @HttpCode(204)
  @ApiOperation({ summary: 'Eliminar la excepción de horario de una fecha' })
  @ApiNoContentResponse({ description: 'Excepción eliminada.' })
  @ApiResponse({ status: 400, description: 'Fecha inválida.' })
  @ApiResponse({ status: 403, description: 'Sin permiso schedule:manage.' })
  @ApiResponse({ status: 404, description: 'Cancha o excepción no encontradas.' })
  deleteException(
    @Param('establishmentId', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Param('date') date: string,
  ): Promise<void> {
    return this.schedule.deleteException(establishmentId, spaceId, date);
  }
}
