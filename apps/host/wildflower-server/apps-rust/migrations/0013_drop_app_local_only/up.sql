-- Drop `app_registrations.local_only`. The column declared an app that makes
-- no network egress, and the only rows that ever held `1` were the on-device
-- self-hosted and system apps, which 0011 and 0012 deleted. Every remaining
-- app is a launch template reached from a remote origin and nothing writes the
-- column but its `DEFAULT 0`, so it carries no information.
--
-- WHY NOT A REBUILD. Unlike 0011 and 0012, no constraint changes: the column
-- is in no index, key, or CHECK, so SQLite's in-place `DROP COLUMN` (3.35+;
-- the bundled SQLite is 3.47) applies, and no other table references
-- `app_registrations`.

ALTER TABLE app_registrations DROP COLUMN local_only;
