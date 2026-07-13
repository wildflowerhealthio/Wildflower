-- Drop the table-per-struct registry. The forward migration is destructive
-- (drop + recreate + reseed), so the down simply tears the new shape back down.
DROP VIEW IF EXISTS apps_view;
DROP TABLE IF EXISTS cloud_apps;
DROP TABLE IF EXISTS self_hosted_apps;
DROP TABLE IF EXISTS home_screen;
