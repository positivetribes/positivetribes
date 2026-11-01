-- Ideas for the hub itself, from every client and from Positive Tribes. Not tied to a client's projects.
-- client_id NULL means Positive Tribes suggested it. Clients see only their own organization's ideas.
-- Status: new (to review), next (approved for the next hub build), later (approved, not yet scheduled),
-- shipped (built and deployed), declined (not planned). The note is Positive Tribes' reply, shown to the client.
CREATE TABLE hub_ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT 'idea' CHECK(tier IN ('must','nice','idea')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','next','later','shipped','declined')),
  note TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '',
  added_email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  shipped_at TEXT
);
CREATE INDEX hub_ideas_status ON hub_ideas(status, client_id);
