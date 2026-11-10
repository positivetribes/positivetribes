-- A suggested change that the signed agreement already covers: the requirement IDs it maps to (e.g. "F7" or "R12, R13").
-- Empty means not marked. Such a change never gets a separate estimate. Additive only.
ALTER TABLE items ADD COLUMN agreement_ref TEXT NOT NULL DEFAULT '';
