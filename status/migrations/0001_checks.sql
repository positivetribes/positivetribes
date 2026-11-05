CREATE TABLE IF NOT EXISTS check_results (
  client   TEXT    NOT NULL,
  check_id TEXT    NOT NULL,
  ts       INTEGER NOT NULL,  -- unix seconds
  ok       INTEGER NOT NULL,  -- 1 up, 0 down
  ms       INTEGER,
  PRIMARY KEY (client, check_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_check_results_ts ON check_results (ts);
