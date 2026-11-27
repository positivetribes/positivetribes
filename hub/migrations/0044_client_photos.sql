-- Client photos (src/photos.js): a banner across the top of a client's home page and a strip of up to three photos near
-- its foot, from photos the client gave Positive Tribes permission to use. The image bytes live in the private R2 bucket
-- `tribe-client-photos` (binding PHOTOS) under <client_id>/<uuid>.jpg and are served only through the hub's API to that
-- client's people and Positive Tribes, never from a public address. Only Positive Tribes adds, changes or removes them.
-- consent: who gave permission and when (required; shown to Positive Tribes only, never sent to the client's browser).
CREATE TABLE client_photos (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  r2_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type = 'image/jpeg'),
  bytes INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('banner', 'strip')),
  alt TEXT NOT NULL,
  focus TEXT NOT NULL DEFAULT 'center' CHECK (focus IN ('top', 'upper', 'center', 'lower', 'bottom')),
  position INTEGER NOT NULL DEFAULT 0,
  consent TEXT NOT NULL,
  added_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX client_photos_client ON client_photos (client_id, role, position);
-- One banner per client.
CREATE UNIQUE INDEX client_photos_one_banner ON client_photos (client_id) WHERE role = 'banner';
