import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { Public } from '../../common/decorators/public.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  AvailabilityQueryDto,
  PublicAvailabilityQueryDto,
} from './dto/availability-query.dto';
import { CreateSpaceDto } from './dto/create-space.dto';
import { ListSpacesQueryDto } from './dto/list-spaces-query.dto';
import { UpdateSpaceDto } from './dto/update-space.dto';
import {
  PublicAvailabilityResponse,
  SpaceListItem,
  SpacesService,
  TenantAvailabilityResponse,
} from './spaces.service';

@ApiTags('spaces')
@Controller('public/establishments')
export class PublicSpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Public()
  @Get(':slug/availability')
  @ApiOperation({
    summary: 'Disponibilidad pública de las canchas de un establecimiento',
    description:
      'No requiere autenticación. Solo devuelve establecimientos y canchas activas; un slug inexistente o inactivo responde 404.',
  })
  @ApiResponse({ status: 200, description: 'Franjas generadas para la fecha.' })
  @ApiResponse({ status: 400, description: 'Fecha inválida.' })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento o cancha no encontrados.',
  })
  getAvailability(
    @Param('slug') slug: string,
    @Query() query: PublicAvailabilityQueryDto,
  ): Promise<PublicAvailabilityResponse> {
    return this.spaces.getPublicAvailability(slug, query.date, query.spaceId);
  }
}

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('establishments/:id/spaces')
@UseGuards(TenantGuard, AuthorizationGuard)
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  @Authorize('space', 'read')
  @ApiOperation({ summary: 'Listar las canchas de un establecimiento' })
  @ApiResponse({ status: 200, description: 'Canchas del establecimiento.' })
  @ApiResponse({ status: 403, description: 'Sin permiso space:read.' })
  @ApiResponse({ status: 404, description: 'Establecimiento no encontrado.' })
  list(
    @Param('id', new ParseUUIDPipe()) establishmentId: string,
    @Query() query: ListSpacesQueryDto,
  ): Promise<SpaceListItem[]> {
    return this.spaces.listSpaces(establishmentId, query);
  }

  @Post()
  @Authorize('space', 'create')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Crear una cancha en el establecimiento',
    description:
      'El slug se genera desde el nombre si se omite y es único por establecimiento. El deporte es obligatorio.',
  })
  @ApiCreatedResponse({ description: 'Cancha creada.' })
  @ApiResponse({ status: 400, description: 'Datos inválidos.' })
  @ApiResponse({ status: 403, description: 'Sin permiso space:create.' })
  @ApiResponse({
    status: 409,
    description: 'El slug ya existe en el establecimiento.',
  })
  create(
    @Param('id', new ParseUUIDPipe()) establishmentId: string,
    @Body() dto: CreateSpaceDto,
  ): Promise<SpaceListItem> {
    return this.spaces.createSpace(establishmentId, dto);
  }

  @Get(':spaceId/availability')
  @Authorize('space', 'read')
  @ApiOperation({ summary: 'Disponibilidad de una cancha para una fecha local' })
  @ApiResponse({ status: 200, description: 'Franjas generadas para la fecha.' })
  @ApiResponse({ status: 400, description: 'Fecha inválida.' })
  @ApiResponse({ status: 403, description: 'Sin permiso space:read.' })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento o cancha no encontrados.',
  })
  availability(
    @Param('id', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<TenantAvailabilityResponse> {
    return this.spaces.getAvailability(establishmentId, spaceId, query.date);
  }

  @Patch(':spaceId')
  @Authorize('space', 'update')
  @ApiOperation({
    summary: 'Actualizar una cancha del establecimiento',
    description:
      'Actualización parcial de datos y estado. Cambiar el estado a maintenance o inactive no elimina ni oculta reservas existentes.',
  })
  @ApiResponse({ status: 200, description: 'Cancha actualizada.' })
  @ApiResponse({ status: 400, description: 'Datos inválidos.' })
  @ApiResponse({ status: 403, description: 'Sin permiso space:update.' })
  @ApiResponse({
    status: 404,
    description: 'Establecimiento o cancha no encontrados.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) establishmentId: string,
    @Param('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Body() dto: UpdateSpaceDto,
  ): Promise<SpaceListItem> {
    return this.spaces.updateSpace(establishmentId, spaceId, dto);
  }
}
