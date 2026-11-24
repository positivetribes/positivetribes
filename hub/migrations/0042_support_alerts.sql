-- The support watch (src/supportwatch.js): which alert or Task has gone out for each item, case, outage or project,
-- so each is sent once per stage. key: item:<id>, case:<Salesforce Id>, outage:<tribe-status incident id>,
-- coverage:<project id>, errors:<day>. No client content is stored here.
CREATE TABLE IF NOT EXISTS support_alerts (
  key TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
