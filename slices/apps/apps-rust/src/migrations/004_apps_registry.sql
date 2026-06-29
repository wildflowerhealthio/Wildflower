-- Clean rebuild: replace the two flat tables (`apps` externals + `internal_apps`)
-- with a curated parent registry plus per-kind child tables. The old tables
-- never shipped to a real user database, so this drops and recreates rather
-- than migrating data. Run-once (index 3 = the 4th migration); a fresh install
-- gets the full seeded set below.
--
-- Parent `apps` is the curated homescreen list: one row per app, with a
-- globally unique `id` across all kinds, ordered by `position`. The taxonomy
-- these columns encode (provenance, local_only, the soft `client_id`) is
-- canonical in docs/Apps/Explanation.md.
DROP TABLE IF EXISTS internal_apps;
DROP TABLE IF EXISTS apps;

CREATE TABLE apps (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- NULL means "no subtitle"; the wire serializes it as an absent field.
    subtitle    TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    -- Display order for `GET /apps` (`ORDER BY position`) and drag-to-reorder.
    position    INTEGER NOT NULL,
    provenance  TEXT NOT NULL CHECK (provenance IN ('system', 'self-hosted', 'cloud')),
    local_only  INTEGER NOT NULL DEFAULT 0,
    -- Soft reference to gatekeeper `clients.client_id` (not an enforced FK); NULL
    -- for non-SMART apps. See docs/Apps/Explanation.md.
    client_id   TEXT
) STRICT;

-- Cloud child: a remote `https://` launch template + whether it needs the
-- tunnel up. The only place a `url` is stored — read shapes never carry one.
CREATE TABLE cloud_apps (
    id              TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    requires_tunnel INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Self-hosted child: the stable dedicated loopback `port`, the on-disk
-- `content_folder` (a subdirectory under the host's installed-apps dir), and the
-- public `subdomain` label (`<subdomain>.<public_host>`). Folder and subdomain
-- are explicit columns, not derived from `id`, so identity / served files /
-- public hostname are independent (the seeds happen to match `id`). See
-- docs/Apps/Explanation.md.
CREATE TABLE self_hosted_apps (
    id             TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    port           INTEGER NOT NULL,
    content_folder TEXT NOT NULL,
    subdomain      TEXT NOT NULL
) STRICT;

-- Parent rows for every seeded app, in display order. System apps (api-view,
-- api-docs) carry no child row; their launch URL comes from the compiled-in
-- `SystemApp` list, which the store tests pin in sync with these rows.
INSERT INTO apps (id, name, subtitle, enabled, position, provenance, local_only, client_id) VALUES
    ('patient-browser', 'Patient Browser', 'Browse patient records served from this device.', 1, 0, 'self-hosted', 1, NULL),
    ('api-view', 'API View', 'View patient records in your browser.', 1, 1, 'system', 1, NULL),
    ('api-docs', 'API Docs', 'View API documentation in your browser.', 1, 2, 'system', 1, NULL),
    ('growth-chart', 'Growth Chart', 'Interactive growth chart app.', 1, 3, 'cloud', 0, 'growth_chart'),
    ('medication-viewer', 'Medication Viewer', 'A bare medication viewer app.', 1, 4, 'cloud', 0, 'my_web_app'),
    ('precise-hbr', 'PRECISE-HBR Risk Calculator', 'Assess risk of major bleeding after percutaneous coronary intervention', 1, 5, 'cloud', 0, 'cc344727-6f90-496c-94fd-c7829aa9a51d');

INSERT INTO cloud_apps (id, url, requires_tunnel) VALUES
    ('growth-chart', 'https://examples.smarthealthit.org/growth-chart-app/launch.html?iss={origin}/fhir-r4&launch={launch}', 1),
    ('medication-viewer', 'https://mitre.github.io/smart-on-fhir-demo/launch.html?iss={origin}/fhir-r4&launch={launch}', 1),
    ('precise-hbr', 'https://hbr.alumicoin.cloud/launch?iss={origin}/fhir-r4&launch={launch}', 1);

INSERT INTO self_hosted_apps (id, port, content_folder, subdomain) VALUES
    ('patient-browser', 8081, 'patient-browser', 'patient-browser');
