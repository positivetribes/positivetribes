-- Screenshots attached to an idea for the hub. The browser shrinks each one before upload (well under D1's 2 MB
-- per value); the server checks the bytes really are a PNG, JPEG or WebP. Seen only by people who can see the idea.
CREATE TABLE hub_idea_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES hub_ideas(id),
  type TEXT NOT NULL CHECK(type IN ('image/png','image/jpeg','image/webp')),
  data BLOB NOT NULL,
  added_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX hub_idea_images_idea ON hub_idea_images(idea_id);
