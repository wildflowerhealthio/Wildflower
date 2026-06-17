-- The apps catalogue. One row per app (bundled and custom alike). Every
-- column is editable post-install — the `kind` tag is preserved as a
-- display-only provenance hint (`bundled` rows shipped with the binary;
-- `custom` rows were added by the user) and has no behavioural effect on
-- the write surface.
--
-- The bundled apps are seeded by this migration; once seeded, the user can
-- rename them, change their URL, toggle `enabled`, or delete them outright.
-- Future bundled additions land as their own migration files; deletion of
-- a bundled row sticks across upgrades because each seed migration only
-- runs once (`schema_migrations.version`), and `INSERT OR IGNORE` keeps
-- subsequent migrations from re-creating a row the user already edited
-- or removed.
CREATE TABLE apps (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('bundled', 'custom')),
    enabled         INTEGER NOT NULL DEFAULT 1,
    name            TEXT NOT NULL,
    -- The descriptive line shown under the app name in the UI. NULL means
    -- "no subtitle"; the wire layer falls back to the URL for that case
    -- so a user-created row without an explicit subtitle still shows
    -- something useful.
    subtitle        TEXT,
    -- A URL template. `{origin}` is replaced with the served origin at
    -- launch time, `{launch}` with a fresh per-launch nonce (for SMART-on-
    -- FHIR apps that round-trip it through the authorize endpoint).
    url             TEXT NOT NULL,
    requires_tunnel INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The shipped-with-the-binary set. URL strings carry `{origin}` /
-- `{launch}` placeholders the launch handler substitutes at request time.
-- FHIR Sharing is intentionally NOT in this list — tunnel control now
-- has its own UI surface (see `tunnel-rust`), and apps slice no longer
-- doubles as a switchboard for it.
INSERT OR IGNORE INTO apps (id, kind, enabled, name, subtitle, url, requires_tunnel) VALUES
    (
        'patient-browser',
        'bundled',
        1,
        'Patient Browser',
        'Browse patient records served from this device.',
        '{origin}/installed-apps/patient-browser/index.html',
        0
    ),
    (
        'api-view',
        'bundled',
        1,
        'API View',
        'View patient records in your browser.',
        '{origin}/fhir-r4/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882',
        0
    ),
    (
        'api-docs',
        'bundled',
        1,
        'API Docs',
        'View API documentation in your browser.',
        '{origin}/docs',
        0
    ),
    (
        'growth-chart',
        'bundled',
        1,
        'Growth Chart',
        'Interactive growth chart app.',
        'https://examples.smarthealthit.org/growth-chart-app/launch.html?iss={origin}/fhir-r4&launch={launch}',
        1
    ),
    (
        'medication-viewer',
        'bundled',
        1,
        'Medication Viewer',
        'A bare medication viewer app.',
        'https://mitre.github.io/smart-on-fhir-demo/launch.html?iss={origin}/fhir-r4&launch={launch}',
        1
    );
