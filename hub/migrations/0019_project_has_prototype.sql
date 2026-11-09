-- A project can skip the Prototype step (e.g. a data migration): 0 hides it from the progress line.
ALTER TABLE projects ADD COLUMN has_prototype INTEGER NOT NULL DEFAULT 1;
UPDATE projects SET has_prototype = 0 WHERE slug = 'virtuous-migration';
