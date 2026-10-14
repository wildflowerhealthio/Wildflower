-- Drop `app_registrations.requires_tunnel`. The column backed a Tunnel pill on
-- an app's tile and had no effect on launch: every launch resolves to the
-- server's public `https://<domain>` origin, so it carries no information.
--
-- WHY NOT A REBUILD. As in 0013, no constraint changes: the column is in no
-- index, key, or CHECK, so SQLite's in-place `DROP COLUMN` (3.35+; the bundled
-- SQLite is 3.47) applies, and no other table references `app_registrations`.

ALTER TABLE app_registrations DROP COLUMN requires_tunnel;
