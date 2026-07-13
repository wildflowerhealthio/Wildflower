-- The apps registry: one shared registration per app of every kind, plus one
-- per-kind configuration table. An app is an `app_registrations` row (the shared
-- catalogue facts + homescreen placement, common to all kinds) paired with the
-- one configuration row its `kind` names (`system_app_configurations` /
-- `cloud_app_configurations` / `self_hosted_app_configurations`), real FKs
-- configuration -> registration with `ON DELETE CASCADE`. `kind` is the
-- discriminator: exactly one configuration table (named by `kind`) holds each
-- id's payload row. The taxonomy these tables encode (kind, local_only, the soft
-- `client_id`, requires_tunnel) is canonical in docs/Apps/Explanation.md.
--
-- This REPLACES the former table-per-struct layout (standalone `cloud_apps` /
-- `self_hosted_apps` each carrying every shared column, a `home_screen` ordering
-- table, and the `apps_view` UNION view) in place — it never shipped, so this
-- drops and recreates rather than migrating data. System apps are ordinary
-- seeded rows: their display fields on the registration and their launch template
-- in `system_app_configurations.url`.
--
-- DESTRUCTIVE-OK: drops every object the prior draft migrations could have
-- created (this shape and the older ones) before recreating.
DROP VIEW IF EXISTS apps_view;
DROP TABLE IF EXISTS system_app_configurations;
DROP TABLE IF EXISTS cloud_app_configurations;
DROP TABLE IF EXISTS self_hosted_app_configurations;
DROP TABLE IF EXISTS system_apps;
DROP TABLE IF EXISTS cloud_apps;
DROP TABLE IF EXISTS self_hosted_apps;
DROP TABLE IF EXISTS home_screen;
DROP TABLE IF EXISTS app_registrations;
DROP TABLE IF EXISTS app_registry;
DROP TABLE IF EXISTS apps;
DROP TABLE IF EXISTS internal_apps;

-- The app registry: one registration row per app of every kind — the global
-- app-id space, the shared catalogue fields, and the homescreen placement
-- (position/on_homescreen, 1:1 with the app). Everything the homescreen tile
-- renders is on this row, so the first load is a single join-free SELECT. `kind`
-- is the discriminator; `position` is UNIQUE so a collision fails the constraint
-- rather than silently tying, and `replace_placements` renumbers through a
-- disjoint negative range to stay collision-free mid-transaction. `client_id` is
-- a SOFT reference to gatekeeper `clients.client_id` (not an enforced FK — an
-- enforced cross-slice FK would couple the migrations); `is_smart` derives from
-- it. `on_homescreen` is the placement flag (whether the tile shows on the home
-- screen), curated atomically by `replace_placements`.
CREATE TABLE app_registrations (
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

-- Per-kind configurations — where the "true" app of each kind lives. PK = FK: a
-- configuration row cannot exist without its registration, and deleting the
-- registration cascades, so `DELETE /apps/{id}` is one statement.
-- (PRAGMA foreign_keys = ON is already set on every pooled connection.)

-- System apps: a compiled-shell route (API View, API Docs). The user can never
-- add, register, or delete one. `url` is the `{origin}`-relative launch template.
CREATE TABLE system_app_configurations (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- {origin}-relative launch template
) STRICT;

-- Cloud apps: a remote launch target reaching PHI back through the tunnel.
CREATE TABLE cloud_app_configurations (
    id  TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations(id) ON DELETE CASCADE,
    url TEXT NOT NULL                              -- https:// or {origin} launch template
) STRICT;

-- Self-hosted apps: web assets served from the device on a dedicated, isolated
-- loopback origin (and remotely at `<subdomain>.<public_host>`). `port` and
-- `subdomain` are UNIQUE (previously enforced only by the in-txn allocator);
-- `content_folder` is where the files live (a per-install mint id, not the id);
-- `seeded = 1` marks the migration-seeded shipped apps (delete/edit-protected);
-- `launch_path` NULL means root-served.
CREATE TABLE self_hosted_app_configurations (
    id             TEXT PRIMARY KEY NOT NULL REFERENCES app_registrations(id) ON DELETE CASCADE,
    port           INTEGER NOT NULL UNIQUE CHECK (port BETWEEN 1 AND 65535),
    content_folder TEXT NOT NULL,
    subdomain      TEXT NOT NULL UNIQUE,
    seeded         INTEGER NOT NULL DEFAULT 0,
    launch_path    TEXT
) STRICT;

-- Seed the default set in display order. Every app is one registration row plus
-- its one configuration row; the two system apps (api-view, api-docs) are seeded
-- rows like any other, their launch templates in `system_app_configurations.url`.
INSERT INTO app_registrations (id, kind, position, on_homescreen, name, subtitle, local_only, client_id, requires_tunnel) VALUES
    ('patient-browser',   'self-hosted', 0, 1, 'Patient Browser', 'Browse patient records served from this device.', 1, NULL, 0),
    ('api-view',          'system',      1, 1, 'API View', 'View patient records in your browser.', 1, NULL, 0),
    ('api-docs',          'system',      2, 1, 'API Docs', 'View API documentation in your browser.', 1, NULL, 0),
    ('growth-chart',      'cloud',       3, 1, 'Growth Chart', 'Interactive growth chart app.', 0, 'growth_chart', 1),
    ('medication-viewer', 'cloud',       4, 1, 'Medication Viewer', 'A bare medication viewer app.', 0, 'my_web_app', 1),
    ('precise-hbr',       'cloud',       5, 1, 'PRECISE-HBR Risk Calculator', 'Assess risk of major bleeding after percutaneous coronary intervention', 0, 'cc344727-6f90-496c-94fd-c7829aa9a51d', 1);

-- The one seeded self-hosted app (seeded = 1 -> delete/edit-protected).
INSERT INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path) VALUES
    ('patient-browser', 8081, 'patient-browser', 'patient-browser', 1, NULL);

-- The seeded system apps' launch templates.
INSERT INTO system_app_configurations (id, url) VALUES
    ('api-view', '{origin}/fhir-r4/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882'),
    ('api-docs', '{origin}/docs');

-- The seeded cloud apps' launch templates.
INSERT INTO cloud_app_configurations (id, url) VALUES
    ('growth-chart', 'https://examples.smarthealthit.org/growth-chart-app/launch.html?iss={origin}/fhir-r4&launch={launch}'),
    ('medication-viewer', 'https://mitre.github.io/smart-on-fhir-demo/launch.html?iss={origin}/fhir-r4&launch={launch}'),
    ('precise-hbr', 'https://hbr.alumicoin.cloud/launch?iss={origin}/fhir-r4&launch={launch}');
