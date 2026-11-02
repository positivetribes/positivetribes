-- Bell notifications. The bell reads the events log; this table remembers which events each client person has read.
-- (Positive Tribes' bell is the command center Inbox, whose read state lives in the admin database's backlog_cleared.)
CREATE TABLE notification_reads (
  user_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL,
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX events_client_id ON events(client_id, id);

-- Phases and documents are often changed by hand in SQL, so the database itself logs the changes clients care about.
-- The actor is Positive Tribes with no email: the command center Inbox leaves those out, every client sees them.
CREATE TRIGGER releases_testing_insert AFTER INSERT ON releases WHEN NEW.stage IN ('uat', 'live')
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  VALUES (NEW.client_id, NEW.id, CASE NEW.stage WHEN 'uat' THEN 'uat_started' ELSE 'live' END,
          COALESCE(NULLIF(NEW.name, ''), 'Phase ' || NEW.number), 'release', '', '', 'Positive Tribes');
END;
CREATE TRIGGER releases_testing_update AFTER UPDATE OF stage ON releases WHEN NEW.stage IN ('uat', 'live') AND OLD.stage != NEW.stage
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  VALUES (NEW.client_id, NEW.id, CASE NEW.stage WHEN 'uat' THEN 'uat_started' ELSE 'live' END,
          COALESCE(NULLIF(NEW.name, ''), 'Phase ' || NEW.number), 'release', '', '', 'Positive Tribes');
END;
CREATE TRIGGER documents_shared_insert AFTER INSERT ON documents WHEN NEW.client_id IS NOT NULL AND NEW.visible = 1
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  VALUES (NEW.client_id, NEW.id, 'shared', NEW.title, 'document', NEW.kind, '', 'Positive Tribes');
END;
CREATE TRIGGER documents_shared_update AFTER UPDATE OF visible, client_id ON documents
  WHEN NEW.client_id IS NOT NULL AND NEW.visible = 1 AND (OLD.visible = 0 OR OLD.client_id IS NOT NEW.client_id)
BEGIN
  INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
  VALUES (NEW.client_id, NEW.id, 'shared', NEW.title, 'document', NEW.kind, '', 'Positive Tribes');
END;
