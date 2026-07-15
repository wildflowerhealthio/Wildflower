-- Drop the cross-kind `grants` VIEW. Runs before 0001's down (reverse order),
-- so the view is gone before its underlying tables are dropped.
DROP VIEW IF EXISTS grants;
