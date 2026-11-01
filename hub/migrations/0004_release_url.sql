-- Each phase has its own link (the build being tested), separate from the project's proof-of-concept link.
ALTER TABLE releases ADD COLUMN url TEXT NOT NULL DEFAULT '';
