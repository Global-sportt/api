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
import { Public } from '../../common/decorators/public.decorator';
import { AppError } from '../../common/errors/app-error';
import { TenantGuard } from '../../common/guards/tenant.guard';
import type {
  AuthenticatedPrincipal,
  TenantRequestContext,
} from '../../common/types/express';
import { AddMembershipDto } from './dto/add-membership.dto';
import { CreateEstablishmentDto } from './dto/create-establishment.dto';
import {
  EstablishmentResponseDto,
  PublicEstablishmentResponseDto,
} from './dto/establishment-response.dto';
import { UpdateEstablishmentDto } from './dto/update-establishment.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import {
  EstablishmentsService,
  type PublicEstablishment,
} from './establishments.service';

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
  @ApiOkResponse({
    type: EstablishmentResponseDto,
    description: 'Establecimiento',
  })
  getById(@Param('id') id: string) {
    return this.establishments.getById(id);
  }

  @Patch(':id')
  @Authorize('establishment', 'update')
  @ApiOperation({
    summary: 'Actualizar el perfil de un establecimiento del tenant',
    description:
      'Actualización parcial del nombre, zona horaria, moneda, datos de contacto y políticas. Al menos un campo; el body vacío responde 400.',
  })
  @ApiOkResponse({
    type: EstablishmentResponseDto,
    description: 'Establecimiento actualizado',
  })
  @ApiResponse({ status: 400, description: 'Datos inválidos o body vacío.' })
  @ApiResponse({ status: 403, description: 'Sin permiso establishment:update.' })
  @ApiResponse({ status: 404, description: 'Establecimiento no encontrado.' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() dto: UpdateEstablishmentDto,
  ) {
    return this.establishments.update(user.userId, id, dto);
  }
}

@ApiTags('establishments')
@Controller('public/establishments')
export class PublicEstablishmentsController {
  constructor(private readonly establishments: EstablishmentsService) {}

  /**
   * Anonymous profile. `@Public()` skips authentication; the service only
   * returns active establishments and treats every other case as 404.
   */
  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Consultar el perfil público de un establecimiento',
    description:
      'No requiere autenticación. Solo devuelve establecimientos activos; un slug inexistente o inactivo responde 404.',
  })
  @ApiOkResponse({
    type: PublicEstablishmentResponseDto,
    description: 'Perfil público del establecimiento',
  })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento no encontrado o no disponible.',
  })
  getBySlug(@Param('slug') slug: string): Promise<PublicEstablishment> {
    return this.establishments.getPublicBySlug(slug);
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
