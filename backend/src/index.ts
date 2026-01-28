import express from 'express';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { loadConfig, saveConfigAtomic } from './config';
import { detectDomainContext } from './lib/detectDomain';
import { buildAuthzMiddleware, buildSessionMiddleware, requireCsrf } from './auth';
import { hardDeny } from './lib/hardDeny';
import { openDb } from './db';
import { pollAllComputers } from './monitor';
import { buildApiRouter } from './routes/api';
import { resolveAllowedGroupDN } from './ad';

type StatusRow = { computerName: string; ipAddress: string; alive: true | false | 'unknown'; errorMessage: string; loggedInUser: string };

function makeStatusCache() {
  let statuses: StatusRow[] = [];
  let groupMembers: any[] | null = null;
  let groupMembersAt = 0;

  return {
    getStatuses: () => statuses,
    setStatuses: (v: StatusRow[]) => {
      statuses = v;
    },
    getGroupMembers: () => {
      const now = Date.now();
      if (!groupMembers) return null;
      if (now - groupMembersAt > 5 * 60 * 1000) return null;
      return groupMembers;
    },
    setGroupMembers: (v: any[]) => {
      groupMembers = v;
      groupMembersAt = Date.now();
    },
  };
}

async function main() {
  const { config, configPath } = await loadConfig();

  // Validate AD connectivity and allowed group resolution at startup (fail closed).
  await resolveAllowedGroupDN(config.allowedAdGroup);

  // First run: domain detection + safe writeback.
  if (!config.detectedDomain || !config.detectedDomain.trim()) {
    const ctx = await detectDomainContext();
    if (ctx.detectedDomain && ctx.detectedDomain.trim()) {
      const updated = { ...config, detectedDomain: ctx.detectedDomain, detectedForest: ctx.detectedForest };
      await saveConfigAtomic(configPath, updated);
    }
  }

  const app = express();
  app.disable('x-powered-by');
  if (process.env.DLT_TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  const listenHost = process.env.DLT_LISTEN_HOST || '127.0.0.1';
  const listenPort = 9191;

  const db = openDb();
  const statusCache = makeStatusCache();

  // Poller loop
  const poll = async () => {
    try {
      const statuses = await pollAllComputers(config);
      statusCache.setStatuses(
        statuses.map((s) => ({
          computerName: s.computerName,
          ipAddress: s.ipAddress,
          alive: s.alive,
          errorMessage: s.errorMessage || s.loggedInUserError,
          loggedInUser: s.loggedInUser,
        }))
      );
    } catch {
      // fail silent; next tick will retry
    }
  };

  await poll();
  setInterval(poll, config.refreshSeconds * 1000).unref();

  // Middleware
  app.use(buildSessionMiddleware());
  app.use(cookieParser());

  // Strict same-origin: if Origin header exists and differs, deny.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    try {
      const o = new URL(origin);
      const host = req.get('host');
      if (!host || o.host !== host) return hardDeny(res, 403);
    } catch {
      return hardDeny(res, 403);
    }
    next();
  });

  // AuthZ gate for everything.
  app.use(buildAuthzMiddleware(config));

  // JSON only after auth gate (so denied users don't learn limits, etc.)
  app.use(express.json({ limit: '10kb', strict: true }));

  // CSRF for any non-GET
  app.use(requireCsrf);

  // API
  app.use('/api', buildApiRouter(config, db, statusCache));

  // Serve frontend (only after auth)
  // Compute workspace root from both dev (src) and built (dist) layouts.
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const distDir = path.resolve(workspaceRoot, 'frontend', 'dist');
  app.use(express.static(distDir, { fallthrough: true, index: false, etag: false, maxAge: 0 }));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  // Any other route: SPA fallback.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });

  // Error handler (authorized requests only reach here)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: any, res: any, _next: any) => {
    res.status(500).type('text/plain').send('Internal Server Error');
  });

  app.listen(listenPort, listenHost, () => {
    // eslint-disable-next-line no-console
    console.log(`DLT backend listening on http://${listenHost}:${listenPort}`);
    // eslint-disable-next-line no-console
    console.log('By: Ray Reeves');
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
