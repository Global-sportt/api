import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../common/authz/authorize.decorator';
import { AuthorizationGuard } from '../../common/authz/authorization.guard';
import { Public } from '../../common/decorators/public.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import {
  AvailabilityQueryDto,
  PublicAvailabilityQueryDto,
} from './dto/availability-query.dto';
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
  ): Promise<SpaceListItem[]> {
    return this.spaces.listSpaces(establishmentId);
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
}
