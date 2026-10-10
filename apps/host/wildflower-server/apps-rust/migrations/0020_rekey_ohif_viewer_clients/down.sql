-- Point the OHIF viewer's tiles back at the clients named after them (see
-- up.sql).
UPDATE app_registrations
   SET client_id = 'ohif-viewer',
       url = CASE url
                 WHEN 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=941de68e6b59eb9dcc32df8ede89e636'
                 THEN 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=ohif-viewer'
                 ELSE url
             END
 WHERE id = 'ohif-viewer';

UPDATE app_registrations
   SET client_id = 'ohif-viewer-dev',
       url = CASE
                 WHEN url LIKE 'http://localhost:%/fhir-viewer?launch={launch}&iss={origin}/fhir-r4&clientId=f9866f7b1d0d8505dc65ef4f749664b5'
                 THEN replace(url, '&clientId=f9866f7b1d0d8505dc65ef4f749664b5', '&clientId=ohif-viewer-dev')
                 ELSE url
             END
 WHERE id = 'ohif-viewer-dev';
