-- Table-per-struct rebuild of the apps registry. Replaces the former
-- class-table-inheritance layout (a parent `apps` table plus `cloud_apps` /
-- `self_hosted_apps` children, and the historical flat `apps` / `internal_apps`
-- tables) with ONE standalone table per concrete kind, each carrying every one
-- of its own columns, plus a dedicated `home_screen` table owning the cross-kind
-- ordering + enabled flag. The table a row lives in IS its provenance — there is
-- no stored `provenance` column any more. System apps have no table: their
-- name / subtitle / launch URL are compiled in (`domain::system_app::SYSTEM_APPS`),
-- so a `home_screen` row referencing the compiled-in id is their only stored
-- state.
--
-- DESTRUCTIVE-OK: the old tables never shipped to a real user database in this
-- shape, so this drops and recreates rather than migrating data (the seeds below
-- are the former migration 004/005/006 seeds re-expressed in the new layout).
-- The taxonomy these tables encode (provenance, local_only, the soft
-- `client_id`) is canonical in docs/Apps/Explanation.md.
DROP VIEW IF EXISTS apps_view;
DROP TABLE IF EXISTS cloud_apps;
DROP TABLE IF EXISTS self_hosted_apps;
DROP TABLE IF EXISTS home_screen;
DROP TABLE IF EXISTS apps;
DROP TABLE IF EXISTS internal_apps;

-- The cross-kind ordering + enabled flag, owning the dense-`0..n`,
-- one-row-per-app homescreen invariant the old parent `apps` table used to
-- enforce. `app_id` is a SOFT reference (SQLite foreign keys can't span the
-- several concrete tables an app id can live in — matches the existing soft
-- `client_id` precedent) into whichever concrete table holds the row, or into a
-- compiled-in system-app id. `position` is UNIQUE so a collision fails the
-- constraint rather than silently producing a tie; `replace_home_screen`
-- renumbers through a disjoint negative range to stay collision-free
-- mid-transaction.
CREATE TABLE home_screen (
    app_id   TEXT PRIMARY KEY NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    enabled  INTEGER NOT NULL DEFAULT 1
) STRICT;

-- Cloud apps: a remote `https://` launch template reaching PHI back through the
-- tunnel. Standalone — carries every column of its own (the formerly-shared
-- name / subtitle / local_only / client_id, plus the cloud payload url /
-- requires_tunnel).
CREATE TABLE cloud_apps (
    id              TEXT PRIMARY KEY NOT NULL,
    name            TEXT NOT NULL,
    -- NULL means "no subtitle"; the wire serializes it as an absent field.
    subtitle        TEXT,
    local_only      INTEGER NOT NULL DEFAULT 0,
    -- Soft reference to gatekeeper `clients.client_id` (not an enforced FK); NULL
    -- for non-SMART apps. See docs/Apps/Explanation.md.
    client_id       TEXT,
    url             TEXT NOT NULL,
    requires_tunnel INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Self-hosted apps: web assets served from the device on a dedicated, isolated
-- loopback origin (and remotely at `<subdomain>.<public_host>`). Standalone —
-- the shared columns plus the payload (stable dedicated `port`, on-disk
-- `content_folder`, public `subdomain` label, `seeded` flag, nullable
-- `launch_path`). Folder and subdomain are explicit columns, not derived from
-- `id`, so identity / served files / public hostname are independent.
CREATE TABLE self_hosted_apps (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    subtitle       TEXT,
    local_only     INTEGER NOT NULL DEFAULT 0,
    client_id      TEXT,
    -- Reject out-of-range ports at write time: the domain reads `port` as a
    -- `u16`, so a row outside `1..=65535` would fail the typed read.
    port           INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    content_folder TEXT NOT NULL,
    subdomain      TEXT NOT NULL,
    seeded         INTEGER NOT NULL DEFAULT 0,
    launch_path    TEXT
) STRICT;

-- The cross-kind read seam: a UNION ALL of the concrete tables joined to their
-- `home_screen` ordering, projecting the shared columns + a `provenance` kind
-- tag + each kind's payload columns (NULL on the other kind's rows). `GET /apps`
-- and every catalogue read decode this; single-kind writes hit the concrete
-- tables directly. System apps are NOT in the view (they have no table); the
-- store folds them in from `home_screen` rows referencing compiled-in ids.
CREATE VIEW apps_view AS
    SELECT
        c.id              AS id,
        c.name            AS name,
        c.subtitle        AS subtitle,
        c.local_only      AS local_only,
        c.client_id       AS client_id,
        h.position        AS position,
        h.enabled         AS enabled,
        'cloud'           AS provenance,
        c.url             AS url,
        c.requires_tunnel AS requires_tunnel,
        NULL              AS port,
        NULL              AS content_folder,
        NULL              AS subdomain,
        NULL              AS seeded,
        NULL              AS launch_path
    FROM cloud_apps c
    JOIN home_screen h ON h.app_id = c.id
    UNION ALL
    SELECT
        s.id              AS id,
        s.name            AS name,
        s.subtitle        AS subtitle,
        s.local_only      AS local_only,
        s.client_id       AS client_id,
        h.position        AS position,
        h.enabled         AS enabled,
        'self-hosted'     AS provenance,
        NULL              AS url,
        NULL              AS requires_tunnel,
        s.port            AS port,
        s.content_folder  AS content_folder,
        s.subdomain       AS subdomain,
        s.seeded          AS seeded,
        s.launch_path     AS launch_path
    FROM self_hosted_apps s
    JOIN home_screen h ON h.app_id = s.id;

-- Seed the default set in display order. System apps (api-view, api-docs) get
-- only a home_screen row — their name / subtitle / launch URL are compiled into
-- SYSTEM_APPS, which the store tests pin in sync with these ids.
INSERT INTO home_screen (app_id, position, enabled) VALUES
    ('patient-browser', 0, 1),
    ('api-view', 1, 1),
    ('api-docs', 2, 1),
    ('growth-chart', 3, 1),
    ('medication-viewer', 4, 1),
    ('precise-hbr', 5, 1);

-- The one seeded self-hosted app (seeded = 1 -> delete-protected).
INSERT INTO self_hosted_apps (id, name, subtitle, local_only, client_id, port, content_folder, subdomain, seeded, launch_path) VALUES
    ('patient-browser', 'Patient Browser', 'Browse patient records served from this device.', 1, NULL, 8081, 'patient-browser', 'patient-browser', 1, NULL);

-- The seeded cloud apps.
INSERT INTO cloud_apps (id, name, subtitle, local_only, client_id, url, requires_tunnel) VALUES
    ('growth-chart', 'Growth Chart', 'Interactive growth chart app.', 0, 'growth_chart', 'https://examples.smarthealthit.org/growth-chart-app/launch.html?iss={origin}/fhir-r4&launch={launch}', 1),
    ('medication-viewer', 'Medication Viewer', 'A bare medication viewer app.', 0, 'my_web_app', 'https://mitre.github.io/smart-on-fhir-demo/launch.html?iss={origin}/fhir-r4&launch={launch}', 1),
    ('precise-hbr', 'PRECISE-HBR Risk Calculator', 'Assess risk of major bleeding after percutaneous coronary intervention', 0, 'cc344727-6f90-496c-94fd-c7829aa9a51d', 'https://hbr.alumicoin.cloud/launch?iss={origin}/fhir-r4&launch={launch}', 1);
