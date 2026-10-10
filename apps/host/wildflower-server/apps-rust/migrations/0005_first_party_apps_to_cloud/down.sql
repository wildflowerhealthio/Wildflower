-- Reverse of up.sql: put the two first-party apps back on self-hosted rows under
-- their original ids. Mirrors up.sql's ordering — drop the cloud payloads first
-- (the FK has no ON UPDATE action, so the registration id can only move once
-- nothing references it), rename back, then re-insert the self-hosted payloads
-- with the same port/subdomain fallbacks 0003/0004 seeded them with (the
-- preferred values can have been taken by an upload in the meantime).
DELETE FROM cloud_app_configurations WHERE id IN ('medications-app', 'web-trace-app');

UPDATE app_registrations
   SET id = 'wildflower-medication',
       client_id = 'wildflower-medication',
       kind = 'self-hosted',
       requires_tunnel = 0
 WHERE id = 'medications-app'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'wildflower-medication');

UPDATE app_registrations
   SET id = 'wildflower-web-trace',
       client_id = 'wildflower-web-trace',
       kind = 'self-hosted',
       local_only = 1,
       requires_tunnel = 0
 WHERE id = 'web-trace-app'
   AND NOT EXISTS (SELECT 1 FROM app_registrations WHERE id = 'wildflower-web-trace');

INSERT OR REPLACE INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path)
SELECT 'wildflower-medication',
       CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = 8090)
            THEN (SELECT MAX(port) + 1 FROM self_hosted_app_configurations)
            ELSE 8090 END,
       'medication',
       CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = 'medication')
            THEN 'wildflower-medication'
            ELSE 'medication' END,
       1,
       '/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'wildflower-medication' AND kind = 'self-hosted');

INSERT OR REPLACE INTO self_hosted_app_configurations (id, port, content_folder, subdomain, seeded, launch_path)
SELECT 'wildflower-web-trace',
       CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE port = 8091)
            THEN (SELECT MAX(port) + 1 FROM self_hosted_app_configurations)
            ELSE 8091 END,
       'web-trace',
       CASE WHEN EXISTS (SELECT 1 FROM self_hosted_app_configurations WHERE subdomain = 'web-trace')
            THEN 'wildflower-web-trace'
            ELSE 'web-trace' END,
       1,
       '/launch.html?launch={launch}&iss={origin}/fhir-r4'
 WHERE EXISTS (SELECT 1 FROM app_registrations WHERE id = 'wildflower-web-trace' AND kind = 'self-hosted');
