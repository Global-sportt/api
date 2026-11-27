import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AppLogger } from './common/logging/app-logger.service';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = app.get(AppLogger);
  app.useLogger(logger);

  configureApp(app, config);
  app.enableShutdownHooks();

  await app.listen(config.env.PORT, '0.0.0.0');
  logger.raw.info(
    {
      event: 'api_started',
      port: config.env.PORT,
      env: config.env.NODE_ENV,
      docs: config.docsEnabled
        ? `${config.env.API_PUBLIC_URL}/${config.env.API_PREFIX}/docs`
        : undefined,
    },
    'api_started',
  );
}

bootstrap().catch((error: unknown) => {
  // No hay logger resuelto si falla la creación del módulo.
  console.error('No se pudo iniciar la API', error);
  process.exit(1);
});
