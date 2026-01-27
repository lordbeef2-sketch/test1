import path from 'node:path';
import Database from 'better-sqlite3';

export type CheckoutRow = {
  computerName: string;
  checkoutUser: string;
  lastUpdatedBy: string;
  lastUpdatedAtUtc: string;
};

export type CheckoutRecord = {
  computerName: string;
  checkoutUser: string;
  checkoutAgeDays: number | null;
  lastUpdatedBy: string | null;
  lastUpdatedAtUtc: string | null;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function getDbPath(): string {
  return process.env.DLT_DB_PATH || path.resolve(__dirname, '../../data/dlt.sqlite');
}

export function openDb(): Database.Database {
  const dbPath = getDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkout (
      computerName TEXT PRIMARY KEY,
      checkoutUser TEXT NOT NULL,
      lastUpdatedBy TEXT NOT NULL,
      lastUpdatedAtUtc TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkout_lastUpdatedAtUtc ON checkout(lastUpdatedAtUtc);
  `);
}

export function readCheckoutMap(db: Database.Database): Map<string, CheckoutRecord> {
  const now = Date.now();
  const rows = db
    .prepare<[], CheckoutRow>(
      'SELECT computerName, checkoutUser, lastUpdatedBy, lastUpdatedAtUtc FROM checkout'
    )
    .all();

  const result = new Map<string, CheckoutRecord>();

  for (const r of rows) {
    const t = Date.parse(r.lastUpdatedAtUtc);
    const expired = Number.isFinite(t) ? now - t > SEVEN_DAYS_MS : true;
    if (expired) {
      // Treat as empty and optionally clean.
      db.prepare('DELETE FROM checkout WHERE computerName = ?').run(r.computerName);
      result.set(r.computerName, {
        computerName: r.computerName,
        checkoutUser: '',
        checkoutAgeDays: null,
        lastUpdatedBy: null,
        lastUpdatedAtUtc: null,
      });
      continue;
    }

    const ageDays = Math.floor((now - t) / (24 * 60 * 60 * 1000));
    result.set(r.computerName, {
      computerName: r.computerName,
      checkoutUser: r.checkoutUser,
      checkoutAgeDays: ageDays,
      lastUpdatedBy: r.lastUpdatedBy,
      lastUpdatedAtUtc: r.lastUpdatedAtUtc,
    });
  }

  return result;
}

export function upsertCheckout(
  db: Database.Database,
  computerName: string,
  checkoutUser: string,
  lastUpdatedBy: string
): CheckoutRow {
  const nowUtc = new Date().toISOString();
  db.prepare(
    `INSERT INTO checkout (computerName, checkoutUser, lastUpdatedBy, lastUpdatedAtUtc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(computerName) DO UPDATE SET
       checkoutUser=excluded.checkoutUser,
       lastUpdatedBy=excluded.lastUpdatedBy,
       lastUpdatedAtUtc=excluded.lastUpdatedAtUtc`
  ).run(computerName, checkoutUser, lastUpdatedBy, nowUtc);

  return {
    computerName,
    checkoutUser,
    lastUpdatedBy,
    lastUpdatedAtUtc: nowUtc,
  };
}
