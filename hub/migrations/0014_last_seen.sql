-- When each person last had the hub open, for the command center ("Molly · last seen 3 days ago").
-- Set when the page loads and while the bell refreshes (at most every 10 minutes per person).
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
