-- Launch each first-party app from its own origin. Every hosted app is
-- published at the root of an origin to itself
-- (`https://<app>.wildflowerhealth.io/`), so no app can read another's
-- `localStorage`; its old path on `https://wildflowerhealth.io` serves only a
-- stub that sends the browser on. Each tile's launch URL moves to the app's
-- origin, keeping its route and query:
--
--   medications     https://medications.wildflowerhealth.io/
--   importer        https://importer.wildflowerhealth.io/
--   plots           https://plots.wildflowerhealth.io/
--   synthetic-data  https://synthetic-data.wildflowerhealth.io/
--   strength        https://strength.wildflowerhealth.io/
--   ohif-viewer     https://ohif-viewer.wildflowerhealth.io/fhir-viewer
--   server-docs     https://server-docs.wildflowerhealth.io/
--
-- As in `0016`, a row is rewritten only while its URL still equals the
-- template the earlier migrations left it with; a URL the user has edited is
-- theirs, and is left alone. The debug-only `…-dev` rows name loopback ports
-- and are untouched.

UPDATE app_registrations
   SET url = 'https://medications.wildflowerhealth.io/?launch={launch}&iss={origin}'
 WHERE id = 'medications'
   AND url = 'https://wildflowerhealth.io/medications/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://importer.wildflowerhealth.io/?launch={launch}&iss={origin}'
 WHERE id = 'importer'
   AND url = 'https://wildflowerhealth.io/importer/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://plots.wildflowerhealth.io/?launch={launch}&iss={origin}'
 WHERE id = 'plots'
   AND url = 'https://wildflowerhealth.io/health-viewer/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://synthetic-data.wildflowerhealth.io/?launch={launch}&iss={origin}'
 WHERE id = 'synthetic-data'
   AND url = 'https://wildflowerhealth.io/synthetic-data/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://strength.wildflowerhealth.io/?launch={launch}&iss={origin}'
 WHERE id = 'strength'
   AND url = 'https://wildflowerhealth.io/lifting/?launch={launch}&iss={origin}';

UPDATE app_registrations
   SET url = 'https://ohif-viewer.wildflowerhealth.io/fhir-viewer?launch={launch}&iss={origin}&clientId=941de68e6b59eb9dcc32df8ede89e636'
 WHERE id = 'ohif-viewer'
   AND url = 'https://wildflowerhealth.io/ohif-viewer/fhir-viewer?launch={launch}&iss={origin}&clientId=941de68e6b59eb9dcc32df8ede89e636';

UPDATE app_registrations
   SET url = 'https://server-docs.wildflowerhealth.io/?server={origin}'
 WHERE id = 'server-docs'
   AND url = 'https://wildflowerhealth.io/server-docs/?server={origin}';
