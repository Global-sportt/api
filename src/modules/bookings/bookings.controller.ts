import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
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
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
} from './booking.constants';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CreateTenantBookingDto } from './dto/create-tenant-booking.dto';
import { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('bookings')
@UseGuards(AuthorizationGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @Authorize('booking', 'create')
  @ApiOperation({
    summary: 'Crear una reserva propia (jugador autenticado)',
    description:
      'El jugador y el precio se resuelven en el servidor. Un Idempotency-Key repetido devuelve 200 con el estado actual.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: false,
    description: 'Clave opcional de idempotencia por actor.',
  })
  @ApiCreatedResponse({ description: 'Reserva creada' })
  @ApiOkResponse({ description: 'Replay idempotente de una reserva existente' })
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CreateBookingDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.bookings.createForPlayer(
      user.userId,
      dto,
      idempotencyKey,
    );

    sendBookingResult(response, result);
  }
}

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('me/bookings')
@UseGuards(AuthorizationGuard)
export class MyBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @Authorize('booking', 'read')
  @ApiOperation({
    summary: 'Listar mis reservas',
    description:
      'Siempre limitado a playerId = principal.id, incluso para platform-admin.',
  })
  @ApiOkResponse({ description: 'Reservas propias' })
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.bookings.listMine(user.userId, query);
  }

  @Get(':id')
  @Authorize('booking', 'read')
  @ApiOperation({ summary: 'Consultar una reserva propia' })
  @ApiOkResponse({ description: 'Reserva propia' })
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.bookings.getMine(user.userId, id);
  }

  @Post(':id/cancel')
  @Authorize('booking', 'cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancelar una reserva propia',
    description:
      'Solo antes de startsAt y en estados pending_payment/confirmed. Una reserva ajena responde 404.',
  })
  @ApiOkResponse({ description: 'Reserva cancelada' })
  cancel(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.bookings.cancelMine(user.userId, id);
  }
}

@ApiTags('bookings')
@ApiBearerAuth()
@Controller('establishments/:establishmentId/bookings')
@UseGuards(TenantGuard, AuthorizationGuard)
export class EstablishmentBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @Authorize('booking', 'read')
  @ApiOperation({ summary: 'Listar reservas del establecimiento (tenant)' })
  @ApiOkResponse({ description: 'Reservas del establecimiento' })
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Query() query: ListBookingsQueryDto,
  ) {
    return this.bookings.listTenant(user.userId, establishmentId, query);
  }

  @Post()
  @Authorize('booking', 'create')
  @ApiOperation({
    summary: 'Crear una reserva para un jugador (tenant)',
    description:
      'staff/owner reserva para un jugador activo del establecimiento del path. El precio se resuelve en el servidor.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: false,
    description: 'Clave opcional de idempotencia por actor.',
  })
  @ApiCreatedResponse({ description: 'Reserva creada' })
  @ApiOkResponse({ description: 'Replay idempotente de una reserva existente' })
  async create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Body() dto: CreateTenantBookingDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.bookings.createForTenant(
      user.userId,
      establishmentId,
      dto,
      idempotencyKey,
    );

    sendBookingResult(response, result);
  }

  @Patch(':bookingId/status')
  @Authorize('booking', 'manage')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cambiar el estado de una reserva (tenant)',
    description:
      'Aplica el grafo de transiciones; un hold vencido no se puede confirmar.',
  })
  @ApiOkResponse({ description: 'Reserva actualizada' })
  updateStatus(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Param('bookingId', new ParseUUIDPipe()) bookingId: string,
    @Body() dto: UpdateBookingStatusDto,
  ) {
    return this.bookings.updateStatus(
      user.userId,
      establishmentId,
      bookingId,
      dto.status,
    );
  }
}

function sendBookingResult(
  response: Response,
  result: {
    booking: unknown;
    replay: boolean;
  },
): void {
  response.status(result.replay ? 200 : 201);
  if (result.replay) {
    response.setHeader(IDEMPOTENT_REPLAY_HEADER, 'true');
  }
  response.json(result.booking);
}
