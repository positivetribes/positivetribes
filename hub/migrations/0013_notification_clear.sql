-- "Clear all" in a client's bell: a cleared notification leaves the list for good (it also counts as read).
ALTER TABLE notification_reads ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1));
