-- Patch reply drafts: Patch drafts a short reply and a suggested status for a suggested change or test problem; the Tribe
-- Guide edits and saves it (or doesn't). Nothing reaches a client by itself.

-- What Patch may say about each client's scope (plain lines, versioned like triage_rules; the newest row is the one in use).
-- Kept apart from triage_rules, which are rules for sorting care requests and hang off a care plan.
CREATE TABLE client_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  version TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 4000),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, version)
);

-- One row per draft, and (once saved) what the Tribe Guide actually sent, so we can see how often a draft goes out unedited.
CREATE TABLE patch_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  facts_version TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  suggested_status TEXT NOT NULL DEFAULT '' CHECK(suggested_status IN ('', 'planned', 'built', 'declined', 'none')),
  status_reason TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT '' CHECK(confidence IN ('', 'high', 'medium', 'low')),
  note TEXT NOT NULL DEFAULT '',
  screen_hits TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_reply TEXT,
  sent_status TEXT,
  sent_at TEXT
);
CREATE INDEX patch_replies_item ON patch_replies(item_id, id);
CREATE INDEX patch_replies_day ON patch_replies(created_at);

-- Drafting needs judgment about scope: use Sonnet for the writing job (Haiku stays as the model to go back to).
UPDATE patch_models SET previous_model = model, model = 'claude-sonnet-5-5', changed_by = 'migration 0024', changed_at = CURRENT_TIMESTAMP WHERE job = 'writing';
