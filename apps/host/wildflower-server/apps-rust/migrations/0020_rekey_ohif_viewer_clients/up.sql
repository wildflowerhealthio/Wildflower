-- Point the OHIF viewer's tiles at clients with random ids (`openssl rand -hex
-- 16`), as `0017` and `0019` did for the other first-party apps. The tile ids
-- `ohif-viewer` and `ohif-viewer-dev` already take the folder's name and stay;
-- only their `client_id`, which until now was the tile id, changes. The
-- matching re-key of gatekeeper's `clients` is gatekeeper migration
-- `0029_rekey_ohif_viewer_clients`.
--
-- OHIF reads its client id off the launch URL (`clientId`, added by `0008`),
-- so each URL names the new client too, but only while it is still the seeded
-- one: a URL the user edited stays as they left it, as in `0016`. The dev row's
-- URL names a loopback port from `dev-app-ports.json`, so it matches on shape.
-- The dev seed (`apps-rust/src/dev_seed.rs`) recognizes a row as its own by
-- exact URL, so the moved URL is what it writes under the new client.
UPDATE app_registrations
   SET client_id = '941de68e6b59eb9dcc32df8ede89e636',
       url = CASE url
                 WHEN 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer'
                 THEN 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=941de68e6b59eb9dcc32df8ede89e636'
                 ELSE url
             END
 WHERE id = 'ohif-viewer';

UPDATE app_registrations
   SET client_id = 'f9866f7b1d0d8505dc65ef4f749664b5',
       url = CASE
                 WHEN url LIKE 'http://localhost:%/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer-dev'
                 THEN replace(url, '&clientId=ohif-viewer-dev', '&clientId=f9866f7b1d0d8505dc65ef4f749664b5')
                 ELSE url
             END
 WHERE id = 'ohif-viewer-dev';
