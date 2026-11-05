-- Care plans (roadmap P1): a monthly plan per client, an append-only credit ledger, and a side row for each backlog
-- item that is a care request (its triage, size, cost and confirmation). Every row carries client_id.

-- Which Salesforce Opportunity sold each tool. Only the Worker writes these, after reading the Opportunity from
-- Salesforce and checking it belongs to this client's own Account.
ALTER TABLE projects ADD COLUMN salesforce_opportunity_id TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN opportunity_won INTEGER NOT NULL DEFAULT 0 CHECK(opportunity_won IN (0,1));
ALTER TABLE projects ADD COLUMN opportunity_checked_at TEXT;

-- One plan per client, covering its live tools. It shows in the client's hub only once active, and it can only be
-- active when the go-live checklist is complete.
CREATE TABLE care_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id),
  tier TEXT NOT NULL CHECK(tier IN ('essentials','care','growth')),
  monthly_credits INTEGER NOT NULL CHECK(monthly_credits BETWEEN 0 AND 100),
  starts_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'setup' CHECK(status IN ('setup','active','paused','ended')),
  repo_url TEXT NOT NULL DEFAULT '',
  test_db TEXT NOT NULL DEFAULT '',
  test_signins_ok INTEGER NOT NULL DEFAULT 0 CHECK(test_signins_ok IN (0,1)),
  rules_version TEXT NOT NULL DEFAULT '',
  balance_contact_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(status != 'active' OR (starts_on != '' AND repo_url != '' AND test_db != '' AND test_signins_ok = 1 AND rules_version != ''))
);

-- Every credit movement, never edited or removed. Balances are computed from it.
-- credits: positive for grant, boost and refund; negative for spend; 0 for a free courtesy edit (counted, not charged).
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  care_plan_id INTEGER NOT NULL REFERENCES care_plans(id),
  kind TEXT NOT NULL CHECK(kind IN ('grant','boost','spend','refund','courtesy')),
  credits INTEGER NOT NULL,
  month TEXT NOT NULL,
  expires_on TEXT,
  item_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((kind IN ('grant','boost','refund') AND credits > 0 AND expires_on IS NOT NULL)
     OR (kind = 'spend' AND credits < 0)
     OR (kind = 'courtesy' AND credits = 0))
);
CREATE INDEX credit_ledger_plan ON credit_ledger(client_id, care_plan_id, at);
-- One monthly grant per plan per month, and at most one spend and one refund per request: no double grant or spend.
CREATE UNIQUE INDEX credit_ledger_grant ON credit_ledger(care_plan_id, month) WHERE kind = 'grant';
CREATE UNIQUE INDEX credit_ledger_spend ON credit_ledger(item_id) WHERE kind = 'spend' AND item_id IS NOT NULL;
CREATE UNIQUE INDEX credit_ledger_refund ON credit_ledger(item_id) WHERE kind = 'refund' AND item_id IS NOT NULL;
CREATE UNIQUE INDEX credit_ledger_courtesy ON credit_ledger(item_id) WHERE kind = 'courtesy' AND item_id IS NOT NULL;
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;

-- A backlog item that is a care request: how the Tribe Guide sorted it, and where it stands.
CREATE TABLE care_requests (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  care_plan_id INTEGER NOT NULL REFERENCES care_plans(id),
  type TEXT CHECK(type IN ('fix','courtesy','improvement','project')),
  size TEXT CHECK(size IN ('S','M','L')),
  credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','awaiting_confirm','waiting_credits','queued','declined','shipped')),
  triage_note TEXT NOT NULL DEFAULT '',
  triaged_by TEXT NOT NULL DEFAULT '',
  triaged_at TEXT,
  confirmed_by TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT,
  shipped_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX care_requests_client ON care_requests(client_id, status);
