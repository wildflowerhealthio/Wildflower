-- Point each first-party tile back at its path on `https://wildflowerhealth.io`,
-- where the row still holds the URL up.sql wrote (see up.sql).

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/medications/?launch={launch}&iss={origin}'
 WHERE id = 'medications'
   AND url = 'https://medications.wildflowerhealth.io/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/importer/?launch={launch}&iss={origin}'
 WHERE id = 'importer'
   AND url = 'https://importer.wildflowerhealth.io/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/health-viewer/?launch={launch}&iss={origin}'
 WHERE id = 'plots'
   AND url = 'https://plots.wildflowerhealth.io/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/synthetic-data/?launch={launch}&iss={origin}'
 WHERE id = 'synthetic-data'
   AND url = 'https://synthetic-data.wildflowerhealth.io/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/lifting/?launch={launch}&iss={origin}'
 WHERE id = 'strength'
   AND url = 'https://strength.wildflowerhealth.io/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}&clientId=941de68e6b59eb9dcc32df8ede89e636'
 WHERE id = 'ohif-viewer'
   AND url = 'https://ohif-viewer.wildflowerhealth.io/fhir-viewer?launch={launch}&iss={origin}&clientId=941de68e6b59eb9dcc32df8ede89e636';

UPDATE app_registrations
   SET url = 'https://wildflowerhealth.io/server-docs/?server={origin}'
 WHERE id = 'server-docs'
   AND url = 'https://server-docs.wildflowerhealth.io/?server={origin}';
