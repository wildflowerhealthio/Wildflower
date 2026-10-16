-- Register each hosted app's own origin as a redirect of its OAuth client.
-- Every hosted app is published on an origin to itself
-- (`https://<app>.wildflowerhealth.io/`), so no app can read another's
-- `localStorage`; a sign-in from there returns to the app's root on that
-- origin (the OHIF viewer's to its `/fhir-viewer` route). The redirect each
-- client already holds, the app's path on `https://wildflowerhealth.io`, stays
-- beside the new one while that path serves a stub sending visitors on to the
-- new origin; a later migration drops it with the stubs.
--
--   9769f8b274370708d0d3ebb2e3e59b7c  https://medications.wildflowerhealth.io/
--   165cd26573e5ac72378e6ad2d2198330  https://importer.wildflowerhealth.io/
--   474e103de61f9141c4b640d59bfa130e  https://plots.wildflowerhealth.io/
--   225ba6af034a3acec6be7ff8010df67f  https://synthetic-data.wildflowerhealth.io/
--   bdf9fc5cb5a28c6683b49896b0ef8a75  https://strength.wildflowerhealth.io/
--   6847df97d54c31936d54ca1b36b3bb09  https://fhir-sync-pebble.wildflowerhealth.io/
--   941de68e6b59eb9dcc32df8ede89e636  https://ohif-viewer.wildflowerhealth.io/fhir-viewer
--   03a513940b52f8c2649a5366d1a26d19  https://launcher.wildflowerhealth.io/
--   7277e898bee8ac81ea44788236e619a5  https://authorization.wildflowerhealth.io/
--   664a01e8614050cd82ffe90350b81413  https://server-docs.wildflowerhealth.io/
--
-- Each new redirect goes in front of the one it joins, and only where the
-- client still holds that seeded redirect: a list the Owner changed is left as
-- it is. A debug build's dev clients redirect to loopback and are untouched.

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/medications/"',
                               '"https://medications.wildflowerhealth.io/","https://wildflowerhealth.io/medications/"')
 WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/importer/"',
                               '"https://importer.wildflowerhealth.io/","https://wildflowerhealth.io/importer/"')
 WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/health-viewer/"',
                               '"https://plots.wildflowerhealth.io/","https://wildflowerhealth.io/health-viewer/"')
 WHERE client_id = '474e103de61f9141c4b640d59bfa130e';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/synthetic-data/"',
                               '"https://synthetic-data.wildflowerhealth.io/","https://wildflowerhealth.io/synthetic-data/"')
 WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/lifting/"',
                               '"https://strength.wildflowerhealth.io/","https://wildflowerhealth.io/lifting/"')
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/fhir-sync-pebble/"',
                               '"https://fhir-sync-pebble.wildflowerhealth.io/","https://wildflowerhealth.io/fhir-sync-pebble/"')
 WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/ohif-viewer/fhir-viewer"',
                               '"https://ohif-viewer.wildflowerhealth.io/fhir-viewer","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"')
 WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/launcher/"',
                               '"https://launcher.wildflowerhealth.io/","https://wildflowerhealth.io/launcher/"')
 WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/authorization/"',
                               '"https://authorization.wildflowerhealth.io/","https://wildflowerhealth.io/authorization/"')
 WHERE client_id = '7277e898bee8ac81ea44788236e619a5';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/server-docs/"',
                               '"https://server-docs.wildflowerhealth.io/","https://wildflowerhealth.io/server-docs/"')
 WHERE client_id = '664a01e8614050cd82ffe90350b81413';
