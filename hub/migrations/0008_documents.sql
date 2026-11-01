-- Documents for a client: proposals first, later agreements, designs and the like. Links, not uploads.
-- An empty url with a note says a document is on its way ("Proposal coming after the Nov 4 budget call").
CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'proposal' CHECK(kind IN ('proposal','agreement','test_script','design','other')),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '' CHECK(status IN ('','draft','sent','signed')),
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX documents_client ON documents(client_id, position);
