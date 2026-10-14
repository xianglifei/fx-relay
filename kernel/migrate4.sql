-- Day 6: deterministic trust gate — task policy, human gate, local check results
ALTER TABLE tasks ADD COLUMN policy TEXT;                -- JSON TaskPolicy: allow/deny globs, max_files, max_diff_bytes
ALTER TABLE tasks ADD COLUMN needs_human_review INTEGER NOT NULL DEFAULT 0;  -- human gate after review approval
ALTER TABLE tasks ADD COLUMN checks TEXT;                -- JSON: {tests:{cmd,exit,tail},lint:{cmd,exit,tail}}
