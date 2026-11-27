import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CerbosClient } from '../../common/authz/cerbos.client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppError } from '../../common/errors/app-error';

@ApiExcludeController()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cerbos: CerbosClient,
  ) {}

  @Public()
  @Get('live')
  live(): { status: string; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness only reports aggregate component status (no URLs, policy
   * details or transport errors). Cerbos is fail-closed for private routes,
   * so an instance without a reachable PDP must not be marked ready.
   */
  @Public()
  @Get('ready')
  async ready(): Promise<{
    status: string;
    database: string;
    cerbos: string;
    timestamp: string;
  }> {
    const [database, cerbos] = await Promise.all([
      this.isDatabaseReady(),
      this.cerbos.isAvailable(),
    ]);

    if (!database) {
      throw new AppError(
        503,
        'DATABASE_UNAVAILABLE',
        'La base de datos no está disponible.',
      );
    }

    if (!cerbos) {
      throw new AppError(
        503,
        'AUTHORIZATION_UNAVAILABLE',
        'El servicio de autorización no está disponible.',
      );
    }

    return {
      status: 'ok',
      database: 'ok',
      cerbos: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  private async isDatabaseReady(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
