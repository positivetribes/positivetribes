-- Donated changes: Positive Tribes can cover a change itself. The estimate keeps its full value (price_cents) and a flag
-- says it is not charged. Time given on a card without an estimate goes in donated_time. Every row carries client_id.
-- Additive only.

ALTER TABLE change_estimates ADD COLUMN donated INTEGER NOT NULL DEFAULT 0 CHECK(donated IN (0, 1));

CREATE TABLE donated_time (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  minutes INTEGER NOT NULL CHECK(minutes BETWEEN 30 AND 12000 AND minutes % 30 = 0),
  -- The client's hourly rate when it was logged, and the value it gives.
  rate_cents INTEGER NOT NULL CHECK(rate_cents BETWEEN 0 AND 100000),
  value_cents INTEGER NOT NULL CHECK(value_cents >= 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX donated_time_client ON donated_time(client_id, item_id);
