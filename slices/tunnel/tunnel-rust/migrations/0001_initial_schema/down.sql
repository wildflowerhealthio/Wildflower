-- Reverse of `up.sql`. Never run at runtime (the store only ever rolls
-- migrations forward); present because the diesel migration harness expects a
-- `down.sql` per migration.
DROP TABLE tunnel_settings;
