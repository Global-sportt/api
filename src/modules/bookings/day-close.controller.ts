import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import type { AuthenticatedPrincipal } from '../../common/types/express';
import { DayCloseService } from './day-close.service';
import {
  CloseDayDto,
  ListDayClosesQueryDto,
} from './dto/day-close.dto';

@ApiTags('day-closes')
@ApiBearerAuth()
@Controller('establishments/:establishmentId/day-closes')
@UseGuards(TenantGuard, AuthorizationGuard)
export class DayCloseController {
  constructor(private readonly dayClosures: DayCloseService) {}

  @Post()
  @Authorize('day', 'close')
  @ApiOperation({
    summary: 'Cerrar el día local y congelar los totales',
    description:
      'Incluye confirmed, checked_in, completed y no_show; excluye cancelled, expired y pending_payment. Un día ya cerrado responde 409; si fue reabierto, recalcula la foto y responde 200.',
  })
  @ApiCreatedResponse({ description: 'Día cerrado' })
  @ApiOkResponse({ description: 'Foto recalculada de un día reabierto' })
  async close(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Body() dto: CloseDayDto,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.dayClosures.closeDay(
      user.userId,
      establishmentId,
      dto.date,
    );

    response.status(result.created ? 201 : 200).json(result.dayClose);
  }

  @Get()
  @Authorize('day', 'close')
  @ApiOperation({
    summary: 'Listar cierres diarios por rango de fechas',
    description: 'Rango máximo de 92 días inclusivos.',
  })
  @ApiOkResponse({ description: 'Cierres del rango' })
  list(
    @Param('establishmentId') establishmentId: string,
    @Query() query: ListDayClosesQueryDto,
  ) {
    return this.dayClosures.list(establishmentId, query);
  }

  @Get(':date')
  @Authorize('day', 'close')
  @ApiOperation({ summary: 'Consultar el cierre de una fecha' })
  @ApiOkResponse({ description: 'Cierre diario' })
  get(
    @Param('establishmentId') establishmentId: string,
    @Param('date') date: string,
  ) {
    return this.dayClosures.getByDate(establishmentId, date);
  }

  @Post(':date/reopen')
  @Authorize('establishment', 'update')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reabrir un día cerrado',
    description:
      'Solo dueño o plataforma. Reabrir un día ya reabierto responde 409.',
  })
  @ApiOkResponse({ description: 'Día reabierto' })
  reopen(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Param('date') date: string,
  ) {
    return this.dayClosures.reopen(user.userId, establishmentId, date);
  }
}
