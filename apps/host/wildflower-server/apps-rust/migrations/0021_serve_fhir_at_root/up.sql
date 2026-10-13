-- The server serves FHIR at its root, so its FHIR base, the `iss` every launch
-- hands an app, is the bare `{origin}` rather than `{origin}/fhir-r4`.
--
-- Unlike `0016` and `0020`, this rewrites every row, the user's edits
-- included: nothing answers at `/fhir-r4` any more, so a URL still naming it
-- launches its app against a server it can't reach. Only the `iss` value
-- changes; the rest of each URL stays as it is. The debug-only `…-dev` rows
-- (`apps-rust`'s `dev_seed.rs`) move the same way, and the dev seed, which
-- recognizes its rows by exact URL, writes the new shape.
UPDATE app_registrations
   SET url = replace(url, 'iss={origin}/fhir-r4', 'iss={origin}')
 WHERE url LIKE '%iss={origin}/fhir-r4%';
