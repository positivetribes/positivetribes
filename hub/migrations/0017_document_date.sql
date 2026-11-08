-- Each document carries its own date (when it was sent, signed or written). Starts as the day it was added to the hub; Eric can edit it.
ALTER TABLE documents ADD COLUMN doc_date TEXT NOT NULL DEFAULT '';
UPDATE documents SET doc_date = substr(created_at, 1, 10) WHERE doc_date = '';
