-- Where the finished app lives once its phases are done (production). Shown to the client only after launch.
ALTER TABLE projects ADD COLUMN live_url TEXT NOT NULL DEFAULT '';
