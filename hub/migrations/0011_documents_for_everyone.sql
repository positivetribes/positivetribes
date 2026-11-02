-- Documents can now belong to Positive Tribes itself (client_id NULL). No client ever sees those: a client's list only
-- reads rows with its own client_id. Three more kinds for Positive Tribes' own papers: plan, process and link.
-- SQLite cannot drop NOT NULL or change a CHECK in place, so the table is rebuilt with the same ids. Nothing references it.
CREATE TABLE documents_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'proposal' CHECK(kind IN ('proposal','agreement','test_script','design','plan','process','link','other')),
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '' CHECK(status IN ('','draft','sent','signed')),
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO documents_new (id, client_id, project_id, kind, title, url, note, status, visible, position, created_at)
  SELECT id, client_id, project_id, kind, title, url, note, status, visible, position, created_at FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX documents_client ON documents(client_id, position);
