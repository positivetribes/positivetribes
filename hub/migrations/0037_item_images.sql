-- Screenshots on backlog items (test problems, suggested changes, support requests, questions), like hub ideas
-- (0010). The browser shrinks each one before upload; the server checks the bytes really are a PNG, JPEG or WebP.
-- Seen only by people who can see the item's client. client_id keeps every row scoped to its client.
CREATE TABLE item_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  type TEXT NOT NULL CHECK(type IN ('image/png','image/jpeg','image/webp')),
  data BLOB NOT NULL,
  added_by TEXT NOT NULL DEFAULT '',
  added_email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX item_images_item ON item_images(client_id, item_id);
