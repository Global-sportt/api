import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import { AppConfigService } from '../config/app-config.service';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../modules/auth/auth.constants';

export function setupSwagger(
  app: INestApplication,
  config: AppConfigService,
): void {
  const builder = new DocumentBuilder()
    .setTitle('API de reservas deportivas')
    .setDescription(
      'Autenticación con correo/contraseña y Google OAuth. Access token corto + refresh rotatorio.',
    )
    .setVersion('1.0.0')
    .addServer(config.env.API_PUBLIC_URL)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token de 15 minutos.',
      },
      'access-token',
    )
    .addCookieAuth(
      REFRESH_COOKIE,
      {
        type: 'apiKey',
        in: 'cookie',
        name: REFRESH_COOKIE,
        description:
          'Cookie httpOnly de refresh. Requiere el header X-CSRF-Token con el valor de ' +
          CSRF_COOKIE +
          '.',
      },
      'refresh-cookie',
    )
    .addTag('auth', 'Registro, login, sesiones, OAuth y contraseñas');

  const document = SwaggerModule.createDocument(app, builder.build(), {
    operationIdFactory: (controllerKey: string, methodKey: string) =>
      `${controllerKey}_${methodKey}`,
  });

  const docsPath = `${config.env.API_PREFIX}/docs`;
  SwaggerModule.setup(docsPath, app, document, {
    jsonDocumentUrl: `${config.env.API_PREFIX}/docs-json`,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      tagsSorter: 'alpha',
    },
  });
}
