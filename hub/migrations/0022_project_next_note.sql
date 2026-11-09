-- A short line shown under a project's current step on the client home page, such as when the next step starts; empty = none.
ALTER TABLE projects ADD COLUMN next_note TEXT NOT NULL DEFAULT '';
UPDATE projects SET next_note = 'Build starts January 4. You can try the prototype now.'
  WHERE slug = 'fundraising' AND client_id = (SELECT id FROM clients WHERE slug = 'uep');
