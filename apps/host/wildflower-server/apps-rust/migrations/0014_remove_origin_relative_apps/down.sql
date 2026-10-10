-- Irreversible by design. An `AppRegistration` row decodes its `url` as an
-- absolute URL, so restoring an origin-relative row would leave the registry
-- unloadable. Down is a deliberate no-op.
SELECT 1;
