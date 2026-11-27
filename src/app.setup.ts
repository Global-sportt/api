import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import type { INestApplication } from '@nestjs/common';
import { AppConfigService } from './config/app-config.service';
import { setupSwagger } from './docs/swagger';

export interface ConfigureAppOptions {
  swagger?: boolean;
}

export function configureApp(
  app: INestApplication,
  config: AppConfigService,
  options: ConfigureAppOptions = {},
): void {
  const express = app.getHttpAdapter().getInstance();
  express.set('trust proxy', config.env.TRUST_PROXY ? 1 : false);
  express.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-csrf-token',
      'x-request-id',
      'accept',
    ],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  app.setGlobalPrefix(config.env.API_PREFIX, {
    exclude: ['health/live', 'health/ready'],
  });

  if (options.swagger !== false && config.docsEnabled) {
    setupSwagger(app, config);
  }
}
