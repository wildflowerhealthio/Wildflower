-- Remove the self-hosted app kind: the registry holds system and cloud apps
-- only. Every first-party app is a cloud row served from the published site
-- (0005 onward), so the remaining self-hosted rows are the `patient-browser`
-- seed from 0002 and any app a user uploaded as a `.zip`. Those registrations
-- are deleted, `self_hosted_app_configurations` is dropped, and the
-- `app_registrations.kind` CHECK is narrowed to `('system', 'cloud')`.
--
-- No soft reference needs cleaning up: the gatekeeper `clients` rows key off
-- `client_id`, and no seeded or uploaded self-hosted app carries one.
--
-- WHY A REBUILD. SQLite can't alter a CHECK constraint in place, so the
-- registry table is recreated. Diesel runs each migration inside a
-- transaction, where `PRAGMA foreign_keys` can't be switched off, so the
-- usual copy-drop-rename would cascade: dropping a parent table performs an
-- implicit `DELETE FROM`, which fires `ON DELETE CASCADE` on the configuration
-- rows. Instead the configuration tables are rebuilt alongside it, pointing at
-- the new registry table, and the old tables are dropped child-first so the
-- parent has no referencing rows when it goes. Renaming `app_registrations_new`
-- to `app_registrations` then rewrites the configuration tables' `REFERENCES`
-- clauses to the final name (SQLite >= 3.26 renames foreign-key targets).
--
-- `position` is renumbered to a dense `0..n` in its existing order while the
-- rows are copied, so the gap the deleted rows leave doesn't survive; it stays
-- UNIQUE.

DELETE FROM self_hosted_app_configurations;
DELETE FROM app_registrations WHERE kind = 'self-hosted';
DROP TABLE self_hosted_app_configurations;

CREATE TABLE app_registrations_new (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('system', 'cloud')),
    position        INTEGER NOT NULL UNIQUE,
    on_homescreen   INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    subtitle        TEXT,                          -- NULL = no subtitle
    local_only      INTEGER NOT NULL DEFAULT 0,
    client_id       TEXT,                          -- soft ref -> gatekeeper clients; is_smart <=> NOT NULL
    requires_tunnel INTEGER NOT NULL DEFAULT 0     -- launch-readiness pill; false for system
) STRICT;

INSERT INTO app_registrations_new
    (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel)
SELECT id,
       kind,
       (SELECT COUNT(*) FROM app_registrations AS earlier WHERE earlier.position < registration.position),
       on_homescreen,
       name,
       subtitle,
       local_only,
       client_id,
       requires_tunnel
  FROM app_registrations AS registration;

CREATE TABLE system_app_configurations_new (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations_new(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- {origin}-relative launch template
) STRICT;

INSERT INTO system_app_configurations_new (id, url)
SELECT id, url FROM system_app_configurations;

CREATE TABLE cloud_app_configurations_new (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations_new(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- https:// or {origin} launch template
) STRICT;

INSERT INTO cloud_app_configurations_new (id, url)
SELECT id, url FROM cloud_app_configurations;

DROP TABLE system_app_configurations;
DROP TABLE cloud_app_configurations;
DROP TABLE app_registrations;

ALTER TABLE app_registrations_new RENAME TO app_registrations;
ALTER TABLE system_app_configurations_new RENAME TO system_app_configurations;
ALTER TABLE cloud_app_configurations_new RENAME TO cloud_app_configurations;
