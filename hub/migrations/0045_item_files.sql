-- Files attached to backlog items (questions, changes, problems, requests): documents, logos, headshots, spreadsheets
-- a client sends with an answer. Asked for by JG Healthcare (hub idea 7, Nov 27, 2026). The bytes live in the private
-- R2 bucket `tribe-client-files` (binding FILES) under <client_id>/items/<item_id>/<uuid>, never at a public address;
-- they are served only through the hub's API, always as a download, to that client's people and Positive Tribes.
-- The server checks each file's real type (src/files.js). client_id keeps every row scoped to its client.
CREATE TABLE item_files (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  added_by TEXT NOT NULL DEFAULT '',
  added_email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX item_files_item ON item_files (client_id, item_id);
