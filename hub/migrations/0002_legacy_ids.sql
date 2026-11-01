-- Keeps the id each row had in its old per-client backlog, so the import can be re-run safely
-- and old #item-<id> links (kept by the command center and shared emails) can be mapped to the new items.
ALTER TABLE items ADD COLUMN legacy_id INTEGER;
ALTER TABLE events ADD COLUMN legacy_id INTEGER;
CREATE UNIQUE INDEX items_legacy ON items(client_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX events_legacy ON events(client_id, legacy_id) WHERE legacy_id IS NOT NULL;
