import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env';
import { AppConfigModule } from './config/app-config.module';
import { LoggingModule } from './common/logging/logging.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuthenticationMiddleware } from './common/middleware/authentication.middleware';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { SecurityMiddleware } from './common/middleware/security.middleware';
import { createValidationPipe } from './common/validation/validation';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { AuthzModule } from './common/authz/authz.module';
import { EstablishmentsModule } from './modules/establishments/establishments.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [
        '.env.local',
        '.env',
        'apps/api/.env.local',
        'apps/api/.env',
      ],
      validate: (raw) => validateEnv(raw as Record<string, unknown>),
    }),
    AppConfigModule,
    PrismaModule,
    LoggingModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    UsersModule,
    AuthModule,
    HealthModule,
    AuthzModule,
    EstablishmentsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
    {
      provide: APP_PIPE,
      useFactory: () => createValidationPipe(),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        RequestContextMiddleware,
        SecurityMiddleware,
        AuthenticationMiddleware,
      )
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
