import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import { AppLogger } from '../logging/app-logger.service';
import { hashIp } from '../utils/crypto.util';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.headers['x-request-id'];
    req.id =
      typeof incomingId === 'string' && REQUEST_ID_PATTERN.test(incomingId)
        ? incomingId
        : randomUUID();
    req.startedAt = performance.now();
    req.ipHash = hashIp(req.ip, this.config.env.PII_HASH_SECRET);

    res.setHeader('X-Request-Id', req.id);
    res.setHeader('Cache-Control', 'no-store');

    res.on('finish', () => {
      this.logger.raw.info(
        {
          event: 'http_request',
          requestId: req.id,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          statusCode: res.statusCode,
          durationMs:
            Math.round((performance.now() - req.startedAt) * 10) / 10,
          ipHash: req.ipHash,
          userId: req.principal?.userId,
          authzDecision: req.authz?.decision,
          cerbosCallId: req.authz?.cerbosCallId,
          userAgent: req.headers['user-agent']?.slice(0, 512),
        },
        'request',
      );
    });

    next();
  }
}
