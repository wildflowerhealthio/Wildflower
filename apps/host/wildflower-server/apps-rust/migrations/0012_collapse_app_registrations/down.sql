-- Reverse of up.sql's SCHEMA change: restore 0011's polymorphic layout — the
-- `kind` column (CHECK `('system', 'cloud')`), a `cloud_app_configurations` row
-- per app holding its `url`, and an empty `system_app_configurations`. Every
-- surviving app is a cloud app. The deleted system registrations and the
-- positions they held are not restored — up.sql discards that data, so the
-- registry stays as it was after up.sql.
-- The rebuild follows up.sql's child-first order for the same reason (see its
-- WHY A REBUILD note): the configuration tables reference
-- `app_registrations_new`, and renaming it to `app_registrations` rewrites
-- their `REFERENCES` clauses to the final name.

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
SELECT id, 'cloud', position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel
  FROM app_registrations;

CREATE TABLE system_app_configurations (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations_new(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- {origin}-relative launch template
) STRICT;

CREATE TABLE cloud_app_configurations (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations_new(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- https:// or {origin} launch template
) STRICT;

INSERT INTO cloud_app_configurations (id, url)
SELECT id, url FROM app_registrations;

DROP TABLE app_registrations;

ALTER TABLE app_registrations_new RENAME TO app_registrations;
