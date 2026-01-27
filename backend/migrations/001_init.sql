-- DLT checkout schema
-- Applied automatically on backend startup.

CREATE TABLE IF NOT EXISTS checkout (
  computerName TEXT PRIMARY KEY,
  checkoutUser TEXT NOT NULL,
  lastUpdatedBy TEXT NOT NULL,
  lastUpdatedAtUtc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkout_lastUpdatedAtUtc
  ON checkout(lastUpdatedAtUtc);
