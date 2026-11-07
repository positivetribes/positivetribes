-- Patch triage (roadmap P2a): Patch, the hub's AI helper, suggests how to sort each new care request; the Tribe Guide
-- agrees or changes it. Trust is earned one kind of decision at a time, from evidence logged here. In P2a every
-- suggestion waits for the Tribe Guide (levels are capped at 1 in code); nothing here reaches a client by itself.

-- Each client's own rules, added to the standard five questions (which live in code as config). Versioned: a change
-- writes a new row, and care_plans.rules_version names the active one, so every decision records the rules it used.
CREATE TABLE triage_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  version TEXT NOT NULL,
  extra TEXT NOT NULL DEFAULT '' CHECK(length(extra) <= 4000),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, version)
);

-- One row per Patch suggestion, and the Tribe Guide's answer to it.
CREATE TABLE patch_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  model TEXT NOT NULL DEFAULT '',
  rules_version TEXT NOT NULL DEFAULT '',
  -- A fingerprint of what Patch read (title, details, question and answer), so a request is checked again only when it changes.
  input_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','agreed','changed','superseded','failed')),
  -- Patch's call. Empty on a failed check.
  kind TEXT CHECK(kind IN ('fix','courtesy','improvement','project','needs_info')),
  size TEXT CHECK(size IN ('S','M','L')),
  confidence TEXT CHECK(confidence IN ('high','medium','low')),
  rule1 INTEGER NOT NULL DEFAULT 0 CHECK(rule1 IN (0,1)),
  screen_hits TEXT NOT NULL DEFAULT '',
  rule_answers TEXT NOT NULL DEFAULT '',
  client_reason TEXT NOT NULL DEFAULT '' CHECK(length(client_reason) <= 300),
  question TEXT NOT NULL DEFAULT '' CHECK(length(question) <= 300),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
  -- Trust at the time: a blind decision hides Patch's call from the Tribe Guide until they have decided.
  trust_kind TEXT NOT NULL DEFAULT '',
  trust_level INTEGER NOT NULL DEFAULT 0,
  blind INTEGER NOT NULL DEFAULT 1 CHECK(blind IN (0,1)),
  -- The Tribe Guide's answer, and how far Patch was from it.
  guide_kind TEXT CHECK(guide_kind IN ('fix','courtesy','improvement','project','needs_info')),
  guide_size TEXT CHECK(guide_size IN ('S','M','L')),
  change_reason TEXT CHECK(change_reason IN ('wrong_kind','wrong_size','missed_rule1','unclear','other')),
  change_note TEXT NOT NULL DEFAULT '',
  miss TEXT CHECK(miss IN ('none','minor','serious')),
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  -- What the check cost.
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX patch_decisions_client ON patch_decisions(client_id, item_id);
CREATE INDEX patch_decisions_trust ON patch_decisions(trust_kind, decided_at);
-- At most one suggestion waiting per request.
CREATE UNIQUE INDEX patch_decisions_pending ON patch_decisions(item_id) WHERE status = 'pending';

-- How far each kind of decision is trusted: 0 Shadow, 1 Suggest, 2 Auto with undo, 3 Auto with spot checks.
-- New projects and anything under rule 1 are not here, so they can never be automated.
CREATE TABLE trust_levels (
  trust_kind TEXT PRIMARY KEY CHECK(trust_kind IN ('fix','courtesy','improvement_S','improvement_M','improvement_L','needs_info')),
  level INTEGER NOT NULL DEFAULT 0 CHECK(level BETWEEN 0 AND 3),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO trust_levels (trust_kind) VALUES ('fix'), ('courtesy'), ('improvement_S'), ('improvement_M'), ('improvement_L'), ('needs_info');

-- Every promotion and demotion, never edited or removed.
CREATE TABLE trust_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trust_kind TEXT NOT NULL,
  from_level INTEGER NOT NULL,
  to_level INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER trust_changes_no_update BEFORE UPDATE ON trust_changes BEGIN SELECT RAISE(ABORT, 'trust_changes is append-only'); END;
CREATE TRIGGER trust_changes_no_delete BEFORE DELETE ON trust_changes BEGIN SELECT RAISE(ABORT, 'trust_changes is append-only'); END;

-- Which exact model each of Patch's jobs uses, set in the command center (never in code), with the one before for rollback.
CREATE TABLE patch_models (
  job TEXT PRIMARY KEY CHECK(job IN ('triage','build','tweak','writing')),
  model TEXT NOT NULL,
  previous_model TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO patch_models (job, model) VALUES ('triage', 'claude-opus-5-5'), ('writing', 'claude-haiku-5-5');

-- Each scheduled or manual check: what it looked at and what it cost. An unfinished row is the lock against overlap.
CREATE TABLE patch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL CHECK(trigger IN ('cron','manual')),
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  checked INTEGER NOT NULL DEFAULT 0,
  decided INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cost_microusd INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);

-- "Needs more info": one clear question on the request, and the client's answer.
ALTER TABLE care_requests ADD COLUMN question TEXT NOT NULL DEFAULT '';
ALTER TABLE care_requests ADD COLUMN question_at TEXT;
ALTER TABLE care_requests ADD COLUMN answer TEXT NOT NULL DEFAULT '';
ALTER TABLE care_requests ADD COLUMN answered_by TEXT NOT NULL DEFAULT '';
ALTER TABLE care_requests ADD COLUMN answered_at TEXT;
