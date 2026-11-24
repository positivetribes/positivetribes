-- Outages: opened after 2 failed probes in a row, closed by the next passing probe (src/incidents.js).
CREATE TABLE IF NOT EXISTS incidents (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  client   TEXT    NOT NULL,
  check_id TEXT    NOT NULL,
  started  INTEGER NOT NULL,  -- unix seconds, first failed probe
  ended    INTEGER            -- unix seconds, first passing probe; NULL while down
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (ended);
