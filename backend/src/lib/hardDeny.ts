import type { Response } from 'express';

export const ACCESS_DENIED_BODY = 'Access Denied';

export function hardDeny(res: Response, status: 401 | 403 = 403, negotiate = false): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  if (negotiate) {
    res.setHeader('WWW-Authenticate', 'Negotiate');
  }
  res.end(ACCESS_DENIED_BODY);
}
