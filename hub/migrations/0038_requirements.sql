-- Requirements the hub can see (Map step 1). Each client project keeps its requirements in a markdown file in its own
-- repo (kits/requirements.md); scripts/requirements-sync.mjs reads that file and replaces this project's rows, so the
-- file stays the source of truth and nobody edits these rows by hand. Status is not stored: the hub works it out from
-- the facts below (cited in code = built, its phase signed off = accepted), see src/requirements.js.
-- state: agreed (a numbered row), proposed / decided (a row under "Proposed, not decided"), out_of_scope, dropped.
CREATE TABLE requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  hub_refs TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'agreed' CHECK (state IN ('agreed', 'proposed', 'decided', 'out_of_scope', 'dropped')),
  cited INTEGER NOT NULL DEFAULT 0 CHECK (cited IN (0, 1)),
  in_uat INTEGER NOT NULL DEFAULT 0 CHECK (in_uat IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, ref)
);
CREATE INDEX requirements_client ON requirements(client_id, project_id);

-- One row per sync run: which file, branch and commit the rows came from, for "last synced" and drift checks.
CREATE TABLE requirement_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  file TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  rows INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX requirement_syncs_project ON requirement_syncs(project_id, id);
