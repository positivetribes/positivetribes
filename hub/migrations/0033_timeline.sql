-- The schedule: one row per bar or date on a client's timeline (command center Timeline tab, Positive Tribes only for now).
-- A bar sits in its project's row (project_id) or, for work with no hub project yet (a proposed build), a named row (lane).
-- Linking a client phase (release_id) lets the bar show that phase's live stage: a tick once signed off, the testing
-- window while in UAT. milestone and deadline rows are single dates drawn as lines across the whole timeline.
-- client_visible is kept for a later client view; nothing shows a row to a client yet.
CREATE TABLE timeline_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  release_id INTEGER REFERENCES releases(id),
  lane TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'ongoing', 'proposed', 'milestone', 'deadline')),
  client_visible INTEGER NOT NULL DEFAULT 0 CHECK (client_visible IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_date = '' OR end_date >= start_date)
);
CREATE INDEX timeline_client ON timeline_entries(client_id, start_date);
