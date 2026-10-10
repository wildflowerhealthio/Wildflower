-- Reverse of up.sql's SCHEMA change: widen the `kind` CHECK back to
-- `('system', 'cloud', 'self-hosted')` and recreate an empty
-- `self_hosted_app_configurations` with 0001's definition. The deleted
-- self-hosted registrations and the positions they held are not restored —
-- up.sql discards that data, so the registry stays as it was after up.sql.
-- The rebuild follows up.sql's child-first order for the same reason (see its
-- WHY A REBUILD note).

CREATE TABLE app_registrations_new (
    id              TEXT PRIMARY KEY NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('system', 'cloud', 'self-hosted')),
    position        INTEGER NOT NULL UNIQUE,
    on_homescreen   INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    subtitle        TEXT,                          -- NULL = no subtitle
    local_only      INTEGER NOT NULL DEFAULT 0,
    client_id       TEXT,                          -- soft ref -> gatekeeper clients; is_smart <=> NOT NULL
    requires_tunnel INTEGER NOT NULL DEFAULT 0     -- launch-readiness pill; false for system/self-hosted
) STRICT;

INSERT INTO app_registrations_new
    (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel)
SELECT id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel
  FROM app_registrations;

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

CREATE TABLE self_hosted_app_configurations (
    id             TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations(id) ON DELETE CASCADE,
    port           INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1 AND 65535),
    content_folder TEXT NOT NULL,
    subdomain      TEXT NOT NULL UNIQUE,
    seeded         INTEGER NOT NULL DEFAULT 0,
    launch_path    TEXT
) STRICT;
