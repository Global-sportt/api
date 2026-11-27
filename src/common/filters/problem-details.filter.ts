import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { AppLogger } from '../logging/app-logger.service';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  423: 'LOCKED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
};

interface ProblemDetailsBody {
  type: string;
  title: string;
  status: number;
  code: string;
  message: string;
  details?: unknown;
  trace_id: string;
  timestamp: string;
  path: string;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    if (response.headersSent) return;

    const problem = this.toProblem(exception, request);
    if (problem.status >= 500) {
      this.logger.raw.error(
        {
          event: 'unhandled_exception',
          requestId: request.id,
          method: request.method,
          path: request.originalUrl.split('?')[0],
          userId: request.principal?.userId,
          err: exception,
        },
        'request_failed',
      );
    }

    response
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }

  private toProblem(exception: unknown, request: Request): ProblemDetailsBody {
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string | undefined;
    let message: string | undefined;
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (typeof record.code === 'string') code = record.code;
        if (record.message !== undefined) {
          message = Array.isArray(record.message)
            ? record.message.join(', ')
            : String(record.message);
        }
        details = record.details;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = this.mapPrismaError(exception);
      status = mapped.status;
      code = mapped.code;
      message = mapped.message;
    } else if (this.hasHttpStatus(exception)) {
      status = exception.status;
      if (exception.message) message = exception.message;
    }

    if (status === 429 && !code) {
      message = 'Demasiadas solicitudes. Intenta de nuevo más tarde.';
    }

    if (status >= 500) {
      message = 'Ocurrió un error interno. Intenta de nuevo más tarde.';
      details = undefined;
    }

    if (!message) {
      message = this.defaultMessage(status);
    }

    return {
      type: 'about:blank',
      title: TITLES[status] ?? 'Error',
      status,
      code: code ?? DEFAULT_CODES[status] ?? 'ERROR',
      message,
      ...(details !== undefined ? { details } : {}),
      trace_id: request.id ?? 'unknown',
      timestamp: new Date().toISOString(),
      path: request.originalUrl.split('?')[0],
    };
  }

  private mapPrismaError(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: string;
    message: string;
  } {
    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'El recurso ya existe.',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'El recurso no existe.',
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: 'RELATION_CONFLICT',
          message: 'La operación entra en conflicto con datos relacionados.',
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: 'DATABASE_ERROR',
          message: 'Error de base de datos.',
        };
    }
  }

  private hasHttpStatus(
    exception: unknown,
  ): exception is { status: number; message?: string } {
    if (!exception || typeof exception !== 'object') return false;
    const status = (exception as { status?: unknown }).status;
    return (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    );
  }

  private defaultMessage(status: number): string {
    switch (status) {
      case 400:
        return 'La solicitud no es válida.';
      case 401:
        return 'No autenticado.';
      case 403:
        return 'No tienes permisos para realizar esta acción.';
      case 404:
        return 'El recurso no existe.';
      case 409:
        return 'La operación entra en conflicto con el estado actual.';
      case 429:
        return 'Demasiadas solicitudes. Intenta de nuevo más tarde.';
      default:
        return 'Ocurrió un error. Intenta de nuevo más tarde.';
    }
  }
}
