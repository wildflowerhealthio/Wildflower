-- Irreversible by design, as for gatekeeper `0011`. This migration repairs rows
-- to the state 0005 already intends; "undoing" it would mean re-breaking a
-- launch that migration was always meant to have fixed, and it cannot tell a row
-- it created from one it merely corrected. Down is a deliberate no-op.
SELECT 1;
