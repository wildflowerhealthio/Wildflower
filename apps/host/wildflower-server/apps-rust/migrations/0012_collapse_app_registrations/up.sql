-- Collapse the registry to a single table: every app is a cloud app, so its
-- launch template moves onto its `app_registrations` row. The two system apps
-- (`api-view`, `api-docs`) are deleted, `app_registrations` is rebuilt without
-- the `kind` column and with `url TEXT NOT NULL` copied from
-- `cloud_app_configurations`, and both configuration tables are dropped.
--
-- No soft reference needs cleaning up: the gatekeeper `clients` rows key off
-- `client_id`, and neither system app carries one.
--
-- WHY A REBUILD. Diesel runs each migration inside a transaction, where
-- `PRAGMA foreign_keys` can't be switched off, so dropping a parent table
-- performs an implicit `DELETE FROM` that fires `ON DELETE CASCADE` on its
-- configuration rows. The rows are copied into `app_registrations_new` first,
-- then the old tables are dropped child-first, so the parent has no
-- referencing table left when it goes, and `app_registrations_new` is renamed
-- to `app_registrations`.
--
-- The copy joins each registration to its cloud configuration, so it carries
-- exactly the registrations that have a launch template. `position` is
-- renumbered to a dense `0..n` in its existing order while the rows are
-- copied, so the gap the deleted rows leave doesn't survive; it stays UNIQUE.

DELETE FROM system_app_configurations;
DELETE FROM app_registrations WHERE kind = 'system';
DROP TABLE system_app_configurations;

CREATE TABLE app_registrations_new (
    id              TEXT PRIMARY KEY NOT NULL,
    position        INTEGER NOT NULL UNIQUE,
    on_homescreen   INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    subtitle        TEXT,                          -- NULL = no subtitle
    url             TEXT NOT NULL,                 -- http(s):// or {origin} launch template
    local_only      INTEGER NOT NULL DEFAULT 0,
    client_id       TEXT,                          -- soft ref -> gatekeeper clients; is_smart <=> NOT NULL
    requires_tunnel INTEGER NOT NULL DEFAULT 0     -- launch-readiness pill
) STRICT;

INSERT INTO app_registrations_new
    (id, position, on_homescreen, name, subtitle, url, local_only, client_id, requires_tunnel)
SELECT registration.id,
       (SELECT COUNT(*) FROM app_registrations AS earlier WHERE earlier.position < registration.position),
       registration.on_homescreen,
       registration.name,
       registration.subtitle,
       configuration.url,
       registration.local_only,
       registration.client_id,
       registration.requires_tunnel
  FROM app_registrations AS registration
  JOIN cloud_app_configurations AS configuration ON configuration.id = registration.id;

DROP TABLE cloud_app_configurations;
DROP TABLE app_registrations;

ALTER TABLE app_registrations_new RENAME TO app_registrations;
