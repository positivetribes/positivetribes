-- Change estimates: Positive Tribes estimates hours for a suggested change that is outside the agreement; the client's
-- director (or the care plan's named contact) decides. Price and credits come from the hours, so Positive Tribes only
-- ever enters hours. Every row carries client_id. Additive only.

-- What one hour costs this client, in cents. A sent estimate keeps its own copy (rate_cents below).
ALTER TABLE clients ADD COLUMN hourly_rate_cents INTEGER NOT NULL DEFAULT 5000 CHECK(hourly_rate_cents BETWEEN 0 AND 100000);

CREATE TABLE change_estimates (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 30 AND 12000 AND minutes % 30 = 0),
  rate_cents INTEGER NOT NULL CHECK(rate_cents BETWEEN 0 AND 100000),
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  credits INTEGER NOT NULL CHECK(credits >= 1),
  schedule_note TEXT NOT NULL DEFAULT '',
  scope_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','offered','approved_now','approved_later','not_now','withdrawn')),
  -- Bumped each time Positive Tribes re-estimates. A decision names the version it saw, so a stale one is refused.
  version INTEGER NOT NULL DEFAULT 1,
  offered_at TEXT,
  decided_at TEXT,
  decided_by_user_id INTEGER REFERENCES users(id),
  decided_version INTEGER,
  -- Random value written by the one request that wins a decision; the item update and event are guarded by it.
  decided_token TEXT NOT NULL DEFAULT '',
  -- Positive Tribes marks an approved change handled once it is billed and scheduled.
  handled_at TEXT,
  -- The Salesforce Task created when a change is approved (empty until then); sf_error says why one could not be.
  sf_task_id TEXT NOT NULL DEFAULT '',
  sf_error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX change_estimates_client ON change_estimates(client_id, status);
