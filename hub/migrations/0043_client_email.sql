-- Client emails (src/clientmail.js): the hub emails a client's people what is waiting on them, so they come back to it.
-- clients.email_mode: off (default: nothing is sent), preview (every email goes to Eric, ALERT_TO, instead of the person),
-- live (sent to the person). email_since: events before it are never emailed, so turning a client on doesn't send history;
-- set it with the mode: UPDATE clients SET email_mode = 'preview', email_since = CURRENT_TIMESTAMP WHERE slug = '...'.
ALTER TABLE clients ADD COLUMN email_mode TEXT NOT NULL DEFAULT 'off' CHECK (email_mode IN ('off', 'preview', 'live'));
ALTER TABLE clients ADD COLUMN email_since TEXT;
-- Each person's choice: all (instant emails + the Monday summary), weekly (the summary only), off.
ALTER TABLE users ADD COLUMN email_pref TEXT NOT NULL DEFAULT 'all' CHECK (email_pref IN ('all', 'weekly', 'off'));
-- One row per email per person, so nothing is sent twice. key: instant:<user id>:<event id>, testing:<user id>:<release id>,
-- digest:<user id>:<week Monday>. Rows are 'pending' while sending; a failed send keeps
-- status 'failed' and is retried by the next run, while 'pending' (sent, but the result was not recorded) is never resent.
-- Holds no client content.
CREATE TABLE email_log (
  key TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('instant', 'digest')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'preview', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX email_log_client ON email_log(client_id, at);
