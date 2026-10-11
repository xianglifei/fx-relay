-- Day 2: review + merge scheduling columns
ALTER TABLE tasks ADD COLUMN review TEXT;       -- JSON: {verdict, reason, instructions, model}
ALTER TABLE tasks ADD COLUMN merged_sha TEXT;   -- set when status=merged
ALTER TABLE tasks ADD COLUMN merged_at TEXT;
