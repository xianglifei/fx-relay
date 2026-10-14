-- Day 6 audit: submit-token creation throttle — atomic per-(minute, baseline) counter
CREATE TABLE IF NOT EXISTS rate_counters (
  minute INTEGER NOT NULL,         -- epoch minute
  baseline TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, baseline)
);
