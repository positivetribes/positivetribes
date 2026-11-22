-- Decisions and dependencies (Map step 2), Positive Tribes only.
-- A decision is one dated choice and what it changed (requirements, hub items), so "why is it like this" has one answer.
-- supersedes_id points at the older decision it replaces.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  decided_on TEXT NOT NULL,
  decided_by TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  affects TEXT NOT NULL DEFAULT '',
  price_change INTEGER NOT NULL DEFAULT 0 CHECK (price_change IN (0, 1)),
  supersedes_id INTEGER REFERENCES decisions(id),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX decisions_client ON decisions(client_id, decided_on);

-- "blocker must happen before blocked". Each end is a timeline entry, a client phase (release), a hub item, or a
-- Salesforce Task (its 15/18-character Id; the hub does not copy its status, label says what it is).
-- needed_by: the date the blocked work needs it, when that is earlier than the blocker's own date.
CREATE TABLE dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  blocker_kind TEXT NOT NULL CHECK (blocker_kind IN ('timeline', 'release', 'item', 'sf_task')),
  blocker_ref TEXT NOT NULL,
  blocked_kind TEXT NOT NULL CHECK (blocked_kind IN ('timeline', 'release', 'item', 'sf_task')),
  blocked_ref TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'blocks' CHECK (kind IN ('blocks', 'needs_input', 'needs_signoff')),
  label TEXT NOT NULL DEFAULT '',
  needed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT (blocker_kind = blocked_kind AND blocker_ref = blocked_ref)),
  UNIQUE (blocker_kind, blocker_ref, blocked_kind, blocked_ref)
);
CREATE INDEX dependencies_client ON dependencies(client_id);
