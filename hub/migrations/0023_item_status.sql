-- Where a suggested change or test problem stands, so nobody has to remember whether it was answered.
-- new = nobody has replied yet; planned = we will do it (or, for a problem, we are fixing it); built = ready to test;
-- declined = not doing it (closed, with the reason in answer). done = 1 still means finished.
-- Other kinds keep 'new' and ignore it. Every existing item starts as new.
ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'built', 'declined'));
