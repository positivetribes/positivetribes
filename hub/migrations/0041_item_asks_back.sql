-- Answer asks something back: Positive Tribes' answer on a question also asks the client a follow-up, so the question
-- stays waiting on its owner (the Map lists it under waiting, not "answered, ready to close"). Set only by Positive
-- Tribes; cleared when someone at the client answers or the question is closed.
ALTER TABLE items ADD COLUMN asks_back INTEGER NOT NULL DEFAULT 0;
