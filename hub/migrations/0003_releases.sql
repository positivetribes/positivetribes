-- Client phases inside a project ("Phase 1", "Phase 2"). Each one is built, tested by the client for at most
-- uat_days (30 by default), then signed off. A built phase can wait for the one before it to be signed off.
CREATE TABLE releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'planned' CHECK (stage IN ('planned', 'building', 'waiting', 'uat', 'signed_off', 'live')),
  uat_started TEXT,
  uat_days INTEGER NOT NULL DEFAULT 30 CHECK (uat_days BETWEEN 1 AND 30),
  signed_off_by TEXT NOT NULL DEFAULT '',
  signed_off_email TEXT NOT NULL DEFAULT '',
  signed_off_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, number)
);
CREATE INDEX releases_client ON releases(client_id, project_id, number);
