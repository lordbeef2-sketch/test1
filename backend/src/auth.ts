import type { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import type { AppConfig } from './config';
import { hardDeny } from './lib/hardDeny';
import { auditLog } from './lib/logger';
import { isUserInGroup, resolveAllowedGroupDN } from './ad';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SQLiteStore = require('connect-sqlite3')(session);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sso } = require('node-expose-sspi');

export type AuthContext = {
  user: string; // DOMAIN\\user or UPN
};

declare module 'express-session' {
  interface SessionData {
    auth?: AuthContext;
    csrf?: string;
    allowedGroupDN?: string;
    allowedGroupDomain?: string | null;
  }
}

function requireSessionSecret(): string {
  const secret = process.env.DLT_SESSION_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error('DLT_SESSION_SECRET must be set to a long random value (>= 32 chars).');
  }
  return secret;
}

export function buildSessionMiddleware() {
  const sessionDbPath = process.env.DLT_SESSION_DB_PATH || './data/sessions.sqlite';
  const path = require('node:path');
  const cookieSecure = process.env.DLT_COOKIE_SECURE === 'true';

  return session({
    name: 'dlt.sid',
    secret: requireSessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure,
      maxAge: 8 * 60 * 60 * 1000,
    },
    store: new SQLiteStore({
      db: path.basename(sessionDbPath),
      dir: path.dirname(sessionDbPath),
      table: 'sessions',
    }),
  });
}

function getSsoMiddleware() {
  return sso.auth({
    useSession: false,
    useGroups: true,
    useActiveDirectory: true,
  });
}

function buildUserLabel(req: any): { user: string; domain: string | null; name: string } | null {
  const u = req?.sso?.user;
  if (!u || !u.name) return null;
  const domain = typeof u.domain === 'string' ? u.domain : null;
  const name = String(u.name);
  const user = domain ? `${domain}\\${name}` : name;
  return { user, domain, name };
}

function randomToken(bytes = 32): string {
  const crypto = require('node:crypto');
  return crypto.randomBytes(bytes).toString('base64url');
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const header = req.header('x-csrf-token') || '';
  const cookie = (req as any).cookies?.['XSRF-TOKEN'] || '';
  const expected = req.session.csrf || '';

  if (!header || !cookie || !expected || header !== cookie || header !== expected) {
    return hardDeny(res, 403);
  }
  next();
}

export function buildAuthzMiddleware(config: AppConfig) {
  const ssoAuth = getSsoMiddleware();

  // Resolve the allowed group DN once and cache it; refresh on restart.
  let allowedGroupPromise: Promise<{ groupDN: string; groupDomainLabel: string | null }> | null = null;
  const getAllowedGroup = () => {
    if (!allowedGroupPromise) {
      allowedGroupPromise = resolveAllowedGroupDN(config.allowedAdGroup);
    }
    return allowedGroupPromise;
  };

  return async function authz(req: Request, res: Response, next: NextFunction) {
    // If already authenticated in session, proceed.
    if (req.session.auth) {
      ensureCsrfCookie(req, res);
      return next();
    }

    // If no Authorization header yet, issue a Negotiate challenge with a strict body.
    // This prevents node-expose-sspi from emitting any default body.
    if (!req.headers.authorization) {
      auditLog({ kind: 'auth_denied' });
      return hardDeny(res, 401, true);
    }

    // Trigger Windows SSO if not authenticated.
    ssoAuth(req, res, async (err: unknown) => {
      if (err) {
        auditLog({ kind: 'auth_denied' });
        return hardDeny(res, 401, true);
      }

      const id = buildUserLabel(req as any);
      if (!id) {
        auditLog({ kind: 'auth_denied' });
        return hardDeny(res, 401, true);
      }

      try {
        const allowed = await getAllowedGroup();
        const ok = await isUserInGroup(id.domain, id.name, allowed.groupDN);

        if (!ok) {
          auditLog({ kind: 'auth_denied', user: id.user });
          return hardDeny(res, 403);
        }

        req.session.auth = { user: id.user };
        req.session.allowedGroupDN = allowed.groupDN;
        req.session.allowedGroupDomain = allowed.groupDomainLabel;
        req.session.csrf = randomToken();
        ensureCsrfCookie(req, res);

        auditLog({ kind: 'auth_success', user: id.user });
        next();
      } catch {
        // Fail closed.
        auditLog({ kind: 'auth_denied', user: id.user });
        return hardDeny(res, 403);
      }
    });
  };
}

function ensureCsrfCookie(req: Request, res: Response): void {
  const token = req.session.csrf;
  if (!token) return;

  // Write as a readable cookie (double submit token pattern), strict sameSite.
  // No domain/path hints beyond root.
  const cookieValue = encodeURIComponent(token);
  const parts = [
    `XSRF-TOKEN=${cookieValue}`,
    'Path=/',
    'SameSite=Strict',
  ];
  // Only add Secure when behind HTTPS (recommended).
  if (process.env.DLT_COOKIE_SECURE === 'true') {
    parts.push('Secure');
  }

  // Not HttpOnly: frontend needs to read it to set X-CSRF-Token.
  const xsrf = parts.join('; ');
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', xsrf);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, xsrf]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), xsrf]);
}
