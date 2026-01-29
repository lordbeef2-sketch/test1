import type { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config';
import { pollAllComputers } from '../monitor';
import type { Db } from '../db';
import { readCheckoutMap, upsertCheckout } from '../db';
import { listAllowedGroupMembers, resolveAndValidateCheckoutUser } from '../ad';
import { auditLog } from '../lib/logger';

const checkoutSchema = z.object({
  computerName: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9\-_.]*$/),
  checkoutUser: z.string().max(256),
});

export function buildApiRouter(config: AppConfig, db: Db, statusCache: StatusCache): Router {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  const router = express.Router();

  router.get('/session', (req: any, res: any) => {
    res.json({
      user: req.session.auth.user,
      refreshSeconds: config.refreshSeconds,
    });
  });

  router.post('/logout', (req: any, res: any) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  router.get('/health', (_req: any, res: any) => {
    res.json({ ok: true });
  });

  router.get('/groupMembers', async (req: any, res: any) => {
    const groupDN = req.session.allowedGroupDN as string;
    const domainLabel = (req.session.allowedGroupDomain ?? null) as string | null;

    const cached = statusCache.getGroupMembers();
    if (cached) return res.json(cached);

    const members = await listAllowedGroupMembers(groupDN, domainLabel);
    statusCache.setGroupMembers(members);
    res.json(members);
  });

  router.get('/status', async (_req: any, res: any) => {
    const statuses = statusCache.getStatuses();
    const checkouts = readCheckoutMap(db);

    const merged = statuses.map((s) => {
      const c = checkouts.get(s.computerName);
      return {
        computerName: s.computerName,
        ipAddress: s.ipAddress,
        alive: s.alive === true ? true : s.alive === false ? false : 'unknown',
        errorMessage: s.errorMessage,
        loggedInUser: s.loggedInUser,
        checkoutUser: c?.checkoutUser || '',
        checkoutAgeDays: c?.checkoutAgeDays ?? null,
        lastUpdatedBy: c?.lastUpdatedBy ?? null,
        lastUpdatedAt: c?.lastUpdatedAtUtc ?? null,
      };
    });

    res.json(merged);
  });

  router.post('/checkout', async (req: any, res: any) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).type('text/plain').send('Invalid checkout user');
    }

    const { computerName, checkoutUser } = parsed.data;

    // Enforce that the target computer exists in config.
    if (!config.computers.some((c) => c.computerName.toLowerCase() === computerName.toLowerCase())) {
      return res.status(400).type('text/plain').send('Invalid checkout user');
    }

    const groupDN = req.session.allowedGroupDN as string;
    const domainLabel = (req.session.allowedGroupDomain ?? null) as string | null;

    const validated = await resolveAndValidateCheckoutUser(checkoutUser, groupDN, domainLabel);
    if (!validated) {
      return res.status(400).type('text/plain').send('Invalid checkout user');
    }

    const normalized = validated.normalized;
    const editor = req.session.auth.user as string;

    const row = upsertCheckout(db, computerName, normalized, editor);
    auditLog({ kind: 'checkout_write', user: editor, computerName, checkoutUser: normalized });

    res.json({
      computerName: row.computerName,
      checkoutUser: row.checkoutUser,
      lastUpdatedBy: row.lastUpdatedBy,
      lastUpdatedAt: row.lastUpdatedAtUtc,
    });
  });

  return router;
}

export type StatusCache = {
  getStatuses: () => Array<{ computerName: string; ipAddress: string; alive: boolean | false | 'unknown'; errorMessage: string; loggedInUser: string }>;
  setStatuses: (v: any[]) => void;
  getGroupMembers: () => any[] | null;
  setGroupMembers: (v: any[]) => void;
};
