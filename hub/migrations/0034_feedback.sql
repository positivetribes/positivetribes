-- How clients feel, asked at the moments that matter (src/feedback.js): a phase signed off, a care request shipped,
-- 30 days after a phase goes live, and a quarterly pulse for clients on a care plan. One row per ask; the person
-- answers with one tap (score) and an optional comment, or says "Not now" (dismissed_at). Each moment asks a person
-- once (the unique index). Answers become a completed Salesforce Task (sf_task_id is the claim, 'pending' while it is
-- being written); a low score also makes a follow-up Task (sf_followup_id). Additive only.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('phase', 'care', 'value', 'pulse')),
  ref_id INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  scale TEXT NOT NULL CHECK (scale IN ('five', 'thumbs', 'value', 'nps')),
  score INTEGER,
  comment TEXT NOT NULL DEFAULT '',
  asked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  answered_at TEXT,
  dismissed_at TEXT,
  sf_task_id TEXT NOT NULL DEFAULT '',
  sf_followup_id TEXT NOT NULL DEFAULT '',
  sf_error TEXT NOT NULL DEFAULT '',
  UNIQUE (user_id, kind, ref_id)
);
CREATE INDEX feedback_client ON feedback(client_id, answered_at);
CREATE INDEX feedback_user ON feedback(user_id, kind, asked_at);
