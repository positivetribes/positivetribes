-- The phase's UAT script (for example a Google Doc), shown next to the build link on the testing card.
ALTER TABLE releases ADD COLUMN script_url TEXT NOT NULL DEFAULT '';
