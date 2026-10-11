-- Day 2 fix: forked_at marks the workspace birth; overlap check uses time, not sha equality
ALTER TABLE tasks ADD COLUMN forked_at TEXT;
UPDATE tasks SET forked_at = created_at WHERE forked_at IS NULL;
