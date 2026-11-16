-- An answer normally starts the 30-day pause before the person's next phase, value or pulse question (src/feedback.js).
-- starts_quiet = 0 marks an ask whose answer doesn't, such as a late question about an earlier phase, so the next
-- phase's question still shows. Additive only; every existing and new ask keeps the pause unless set by hand.
ALTER TABLE feedback ADD COLUMN starts_quiet INTEGER NOT NULL DEFAULT 1 CHECK (starts_quiet IN (0, 1));
