import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthenticatedOnly } from '../../common/authz/authenticated-only.decorator';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppError } from '../../common/errors/app-error';
import { TenantGuard } from '../../common/guards/tenant.guard';
import type {
  AuthenticatedPrincipal,
  TenantRequestContext,
} from '../../common/types/express';
import { AddMembershipDto } from './dto/add-membership.dto';
import { CreateEstablishmentDto } from './dto/create-establishment.dto';
import { UpdateEstablishmentStatusDto } from './dto/update-establishment-status.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { EstablishmentsService } from './establishments.service';

@ApiTags('establishments')
@ApiBearerAuth()
@Controller('admin/establishments')
@UseGuards(AuthorizationGuard)
export class AdminEstablishmentsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  @Post()
  @Authorize('establishment', 'create')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Crear un establecimiento con su primer owner activo',
  })
  @ApiCreatedResponse({ description: 'Establecimiento creado' })
  create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: CreateEstablishmentDto,
  ) {
    return this.establishments.create(user.userId, dto);
  }

  @Get()
  @Authorize('establishment', 'read')
  @ApiOperation({ summary: 'Listar establecimientos (plataforma)' })
  @ApiOkResponse({ description: 'Listado de establecimientos' })
  list() {
    return this.establishments.list();
  }

  @Patch(':id/status')
  @Authorize('establishment', 'suspend')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suspender o reactivar un establecimiento (plataforma)',
    description:
      'Solo platform-admin. Transiciones permitidas: active -> suspended y suspended -> active. Repetir el estado actual responde 200 sin escribir; cualquier otra transición responde 409 INVALID_STATE. La suspensión no borra canchas, horarios ni reservas.',
  })
  @ApiOkResponse({ description: 'Establecimiento con su estado actualizado' })
  @ApiResponse({ status: 400, description: 'status inválido o ausente.' })
  @ApiResponse({
    status: 403,
    description: 'Sin permiso establishment:suspend.',
  })
  @ApiResponse({ status: 404, description: 'Establecimiento no encontrado.' })
  @ApiResponse({
    status: 409,
    description: 'Transición de estado no permitida.',
  })
  changeStatus(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpdateEstablishmentStatusDto,
  ) {
    return this.establishments.changeStatus(user.userId, id, dto.status);
  }
}

@ApiTags('establishments')
@ApiBearerAuth()
@Controller('me/establishments')
export class MyEstablishmentsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  /**
   * `/me` is global context: authentication is enough, no Cerbos check and no
   * `TenantGuard` (there is no tenant param). The response is always scoped to
   * the authenticated user.
   */
  @Get()
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Listar mis establecimientos y mis membresías' })
  @ApiOkResponse({ description: 'Membresías del usuario autenticado' })
  listMine(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.establishments.listMine(user.userId);
  }
}

@ApiTags('establishments')
@ApiBearerAuth()
@Controller('establishments')
@UseGuards(TenantGuard, AuthorizationGuard)
export class EstablishmentsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  @Get(':id')
  @Authorize('establishment', 'read')
  @ApiOperation({ summary: 'Consultar un establecimiento del tenant' })
  @ApiOkResponse({ description: 'Establecimiento' })
  getById(@Param('id') id: string) {
    return this.establishments.getById(id);
  }
}

@ApiTags('establishments')
@ApiBearerAuth()
@Controller('establishments/:establishmentId/memberships')
@UseGuards(TenantGuard, AuthorizationGuard)
export class MembershipsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  @Get()
  @Authorize('membership', 'read')
  @ApiOperation({ summary: 'Listar membresías del establecimiento' })
  @ApiOkResponse({ description: 'Membresías' })
  list(@Param('establishmentId') establishmentId: string) {
    return this.establishments.listMemberships(establishmentId);
  }

  @Post()
  @Authorize('membership', 'manage')
  @HttpCode(201)
  @ApiOperation({ summary: 'Agregar o reactivar una membresía' })
  @ApiCreatedResponse({ description: 'Membresía creada o reactivada' })
  add(
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Body() dto: AddMembershipDto,
  ) {
    return this.establishments.addMembership(
      tenantOf(request),
      user.userId,
      establishmentId,
      dto,
    );
  }

  @Patch(':membershipId')
  @Authorize('membership', 'manage')
  @ApiOperation({ summary: 'Cambiar estado o grupo de una membresía' })
  @ApiOkResponse({ description: 'Membresía actualizada' })
  update(
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Param('membershipId') membershipId: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.establishments.updateMembership(
      tenantOf(request),
      user.userId,
      establishmentId,
      membershipId,
      dto,
    );
  }

  @Delete(':membershipId')
  @Authorize('membership', 'manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Retirar una membresía (soft delete)' })
  @ApiOkResponse({ description: 'Membresía retirada' })
  remove(
    @Req() request: Request,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('establishmentId') establishmentId: string,
    @Param('membershipId') membershipId: string,
  ) {
    return this.establishments.removeMembership(
      tenantOf(request),
      user.userId,
      establishmentId,
      membershipId,
    );
  }
}

function tenantOf(request: Request): TenantRequestContext {
  if (!request.tenant) {
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      'El contexto de tenant no está disponible.',
    );
  }

  return request.tenant;
}
