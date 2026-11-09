-- A client's logo mark, a file in hub/public/logos/ (square, shown on a white tile next to the workspace name); empty = no logo.
ALTER TABLE clients ADD COLUMN logo TEXT NOT NULL DEFAULT '';
UPDATE clients SET logo = '/logos/uep.png' WHERE slug = 'uep';
UPDATE clients SET logo = '/logos/coyote.png' WHERE slug = 'coyote';
