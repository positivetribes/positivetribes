-- Map step 4: one compact snapshot of the Map per week (src/mapdigest.js), saved by the Monday cron or Run now on
-- Today, so Today can say what changed since last week. Names, counts and ids only; no personal data. Kept 26 weeks.
CREATE TABLE map_snapshots (
  week_start TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
