import { HttpException } from '@nestjs/common';

export class AppError extends HttpException {
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super({ statusCode: status, code, message, details }, status);
    this.code = code;
    this.details = details;
  }
}
