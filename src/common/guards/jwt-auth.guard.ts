import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppError } from '../errors/app-error';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (request.principal) return true;

    if (request.authError === 'expired_token') {
      throw new AppError(
        401,
        'TOKEN_EXPIRED',
        'El token de acceso expiró. Renueva la sesión.',
      );
    }

    if (request.authError === 'invalid_token') {
      throw new AppError(
        401,
        'INVALID_TOKEN',
        'El token de acceso no es válido.',
      );
    }

    throw new AppError(
      401,
      'UNAUTHENTICATED',
      'Se requiere autenticación para acceder a este recurso.',
    );
  }
}
