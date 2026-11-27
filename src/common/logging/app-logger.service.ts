import { Injectable, LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';
import { AppConfigService } from '../../config/app-config.service';

@Injectable()
export class AppLogger implements LoggerService {
  private readonly logger: Logger;

  constructor(private readonly config: AppConfigService) {
    this.logger = pino({
      level: config.env.LOG_LEVEL,
      base: {
        service: 'reservas-api',
        env: config.env.NODE_ENV,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'password',
          'passwordHash',
          'token',
          'accessToken',
          'refreshToken',
          'authorization',
          'cookie',
          'code',
          'id_token',
        ],
        censor: '[REDACTED]',
      },
      transport:
        config.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:standard',
              },
            }
          : undefined,
    });
  }

  get raw(): Logger {
    return this.logger;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.info(
      { context: this.contextFrom(optionalParams) },
      this.format(message),
    );
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.error(
      {
        context: this.contextFrom(optionalParams),
        err: message instanceof Error ? message : undefined,
      },
      message instanceof Error ? message.message : this.format(message),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.warn(
      { context: this.contextFrom(optionalParams) },
      this.format(message),
    );
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.debug(
      { context: this.contextFrom(optionalParams) },
      this.format(message),
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.trace(
      { context: this.contextFrom(optionalParams) },
      this.format(message),
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logger.fatal(
      { context: this.contextFrom(optionalParams) },
      this.format(message),
    );
  }

  private contextFrom(params: unknown[]): string | undefined {
    for (let index = params.length - 1; index >= 0; index -= 1) {
      if (typeof params[index] === 'string') return params[index] as string;
    }
    return undefined;
  }

  private format(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}
