-- Point every launch's `iss` back at `{origin}/fhir-r4` (see up.sql).
UPDATE app_registrations
   SET url = replace(url, 'iss={origin}', 'iss={origin}/fhir-r4')
 WHERE url LIKE '%iss={origin}%'
   AND url NOT LIKE '%iss={origin}/%';
