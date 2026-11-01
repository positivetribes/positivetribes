-- Tribe Hub: one database for every client. Every client-owned row carries client_id.
CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  accent TEXT NOT NULL DEFAULT '#a8492c',
  salesforce_account_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','support','paused','closed')),
  go_live_date TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- role: ed = executive director, staff = client staff, pt = Positive Tribes (client_id NULL means all clients).
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('ed','staff','pt')),
  client_id INTEGER REFERENCES clients(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((role = 'pt') = (client_id IS NULL))
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  poc_url TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'kickoff' CHECK(phase IN ('kickoff','discovery','prototype','build','uat','launch','hypercare','support')),
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(client_id, slug)
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'change' CHECK(kind IN ('question','change','problem','request')),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL CHECK(tier IN ('must','nice','idea')),
  phase TEXT NOT NULL DEFAULT 'review' CHECK(phase IN ('review','prototype','full','later')),
  position INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  due_date TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX items_list ON items(client_id, project_id, kind, tier, position);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  item_title TEXT NOT NULL,
  item_kind TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX events_client ON events(client_id, at);
