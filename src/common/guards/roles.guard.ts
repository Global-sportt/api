import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppRole } from '../auth/roles';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AppError } from '../errors/app-error';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = request.principal;
    if (!principal) {
      throw new AppError(
        401,
        'UNAUTHENTICATED',
        'Se requiere autenticación para acceder a este recurso.',
      );
    }

    if (!requiredRoles.includes(principal.role)) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'No tienes permisos para realizar esta acción.',
      );
    }

    return true;
  }
}
