-- Irreversible by design. This migration repairs rows to the state every other
-- migration already intends; "undoing" it would mean re-breaking a client that
-- 0006 was always meant to have fixed, and it cannot tell a row it created from
-- one it merely corrected. Down is a deliberate no-op.
SELECT 1;
