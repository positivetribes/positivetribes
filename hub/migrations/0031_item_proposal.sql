-- A suggested change that is big enough to need its own proposal (fixed scope, price and monthly plan) instead of an
-- hours estimate. '' = not marked; planned = "we'll send a proposal"; sent = the proposal went out (optionally linked
-- to its row in documents, which the client sees only once that document is visible). Additive only.
ALTER TABLE items ADD COLUMN proposal_state TEXT NOT NULL DEFAULT '' CHECK (proposal_state IN ('', 'planned', 'sent'));
ALTER TABLE items ADD COLUMN proposal_document_id INTEGER REFERENCES documents(id);
