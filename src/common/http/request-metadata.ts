import type { Request } from 'express';

export interface RequestMetadata {
  requestId: string;
  ipHash?: string;
  userAgent?: string;
}

export function requestMetadata(req: Request): RequestMetadata {
  return {
    requestId: req.id,
    ipHash: req.ipHash,
    userAgent: req.headers['user-agent']?.slice(0, 512),
  };
}
