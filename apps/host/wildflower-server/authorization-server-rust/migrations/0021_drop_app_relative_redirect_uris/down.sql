-- Irreversible by design. A `Client` row decodes every redirect entry as an
-- absolute URL, so restoring a path entry would leave its row unloadable. Down
-- is a deliberate no-op.
SELECT 1;
