-- Items ride a release: tag a suggested change or test problem with the client phase it ships in (items.release_id), and
-- the status follows the release by itself, however the release is moved (the hub, or SQL by hand).
--   Release starts testing  -> its Planned items become Built, ready to test (the client's bell hears about their own).
--   Release signed off/live -> its Planned or Built items are done.
-- Untouched on purpose: New and Not doing items, anything already done, and care requests (they close through their own
-- steps). Items with no release_id behave exactly as before, by hand.
ALTER TABLE items ADD COLUMN release_id INTEGER REFERENCES releases(id);
CREATE INDEX items_release ON items(release_id);

CREATE TRIGGER releases_items_testing AFTER UPDATE OF stage ON releases WHEN NEW.stage = 'uat' AND OLD.stage != 'uat'
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  SELECT i.client_id, i.id, 'status', i.title, i.kind, CASE i.kind WHEN 'problem' THEN 'Fixed, ready to retest' ELSE 'Built, ready to test' END, '', 'Positive Tribes'
  FROM items i
  WHERE i.release_id = NEW.id AND i.client_id = NEW.client_id AND i.kind IN ('change', 'problem') AND i.status = 'planned' AND i.done = 0
    AND NOT EXISTS (SELECT 1 FROM care_requests c WHERE c.item_id = i.id);
  UPDATE items SET status = 'built', updated_at = CURRENT_TIMESTAMP
  WHERE release_id = NEW.id AND client_id = NEW.client_id AND kind IN ('change', 'problem') AND status = 'planned' AND done = 0
    AND NOT EXISTS (SELECT 1 FROM care_requests c WHERE c.item_id = items.id);
END;

CREATE TRIGGER releases_items_signed_off AFTER UPDATE OF stage ON releases
WHEN NEW.stage IN ('signed_off', 'live') AND OLD.stage NOT IN ('signed_off', 'live')
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  SELECT i.client_id, i.id, 'done', i.title, i.kind, '', '', 'Positive Tribes'
  FROM items i
  WHERE i.release_id = NEW.id AND i.client_id = NEW.client_id AND i.kind IN ('change', 'problem') AND i.status IN ('planned', 'built') AND i.done = 0
    AND NOT EXISTS (SELECT 1 FROM care_requests c WHERE c.item_id = i.id);
  UPDATE items SET status = 'built', done = 1, updated_at = CURRENT_TIMESTAMP
  WHERE release_id = NEW.id AND client_id = NEW.client_id AND kind IN ('change', 'problem') AND status IN ('planned', 'built') AND done = 0
    AND NOT EXISTS (SELECT 1 FROM care_requests c WHERE c.item_id = items.id);
END;
