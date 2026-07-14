-- Seed the default registry (schema built by `0001_app_registrations`). Kept a
-- separate migration from the schema so the shipped default set versions on its
-- own: a change to which apps ship is a new migration here, not an edit to the
-- table definitions. Because each migration runs only once per database, a
-- user-deleted seed stays deleted across upgrades.
--
-- Every app is one registration row plus its one configuration row, in display
-- order; the two system apps (api-view, api-docs) are seeded rows like any other,
-- their launch templates in `system_app_configurations.url`.
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
