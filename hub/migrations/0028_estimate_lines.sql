-- What an estimate includes, in the client's words: a JSON list of {label, minutes}, up to 8. When it has lines, the
-- estimate's minutes are their sum, so the breakdown and the price never disagree. Empty means a single number.
-- Additive only.
ALTER TABLE change_estimates ADD COLUMN lines TEXT NOT NULL DEFAULT '[]';
