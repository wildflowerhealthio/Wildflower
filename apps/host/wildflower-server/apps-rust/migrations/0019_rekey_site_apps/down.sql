-- Restore the ids and published paths the site's apps had before `0019`, and
-- remove the Synthetic Data Loader tile it seeded (see up.sql).
DELETE FROM app_registrations WHERE id = 'synthetic-data';

UPDATE app_registrations
   SET id = 'medications-app',
       client_id = 'medications-app',
       url = replace(url,
                     'https://wildflowerhealth.io/medications/',
                     'https://wildflowerhealth.io/medications-app/')
 WHERE id = 'medications';

UPDATE app_registrations
   SET id = 'medications-app-dev',
       client_id = 'medications-app-dev'
 WHERE id = 'medications-dev';

UPDATE app_registrations
   SET id = 'importer-app',
       client_id = 'importer-app',
       url = replace(url,
                     'https://wildflowerhealth.io/importer/',
                     'https://wildflowerhealth.io/importer-app/')
 WHERE id = 'importer';

UPDATE app_registrations
   SET id = 'importer-app-dev',
       client_id = 'importer-app-dev'
 WHERE id = 'importer-dev';

UPDATE app_registrations
   SET id = 'health-viewer-app',
       client_id = 'health-viewer-app',
       url = replace(url,
                     'https://wildflowerhealth.io/health-viewer/',
                     'https://wildflowerhealth.io/health-viewer-app/')
 WHERE id = 'health-viewer';

UPDATE app_registrations
   SET id = 'health-viewer-app-dev',
       client_id = 'health-viewer-app-dev'
 WHERE id = 'health-viewer-dev';

UPDATE app_registrations
   SET id = 'synthetic-data-app-dev',
       client_id = 'synthetic-data-app-dev'
 WHERE id = 'synthetic-data-dev';

UPDATE app_registrations
   SET id = 'web-server-docs',
       client_id = 'web-server-docs',
       url = replace(url,
                     'https://wildflowerhealth.io/server-docs/',
                     'https://wildflowerhealth.io/wildflower-server-docs/')
 WHERE id = 'server-docs';

UPDATE app_registrations
   SET id = 'web-server-docs-dev',
       client_id = 'web-server-docs-dev'
 WHERE id = 'server-docs-dev';
