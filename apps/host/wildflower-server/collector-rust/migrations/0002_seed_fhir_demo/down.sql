-- Reverse of `up.sql`. Never run at runtime; present because the diesel
-- migration harness expects a `down.sql` per migration.
DELETE FROM collector_remotes WHERE id = 'fhir-demo';
