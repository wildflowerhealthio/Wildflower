-- Reverse of up.sql: drop each hosted app's own-origin redirect again, where
-- the client still holds it in front of the redirect up.sql found.

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://medications.wildflowerhealth.io/","https://wildflowerhealth.io/medications/"',
                               '"https://wildflowerhealth.io/medications/"')
 WHERE client_id = '9769f8b274370708d0d3ebb2e3e59b7c';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://importer.wildflowerhealth.io/","https://wildflowerhealth.io/importer/"',
                               '"https://wildflowerhealth.io/importer/"')
 WHERE client_id = '165cd26573e5ac72378e6ad2d2198330';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://plots.wildflowerhealth.io/","https://wildflowerhealth.io/health-viewer/"',
                               '"https://wildflowerhealth.io/health-viewer/"')
 WHERE client_id = '474e103de61f9141c4b640d59bfa130e';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://synthetic-data.wildflowerhealth.io/","https://wildflowerhealth.io/synthetic-data/"',
                               '"https://wildflowerhealth.io/synthetic-data/"')
 WHERE client_id = '225ba6af034a3acec6be7ff8010df67f';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://strength.wildflowerhealth.io/","https://wildflowerhealth.io/lifting/"',
                               '"https://wildflowerhealth.io/lifting/"')
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://fhir-sync-pebble.wildflowerhealth.io/","https://wildflowerhealth.io/fhir-sync-pebble/"',
                               '"https://wildflowerhealth.io/fhir-sync-pebble/"')
 WHERE client_id = '6847df97d54c31936d54ca1b36b3bb09';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://ohif-viewer.wildflowerhealth.io/fhir-viewer","https://wildflowerhealth.io/ohif-viewer/fhir-viewer"',
                               '"https://wildflowerhealth.io/ohif-viewer/fhir-viewer"')
 WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://launcher.wildflowerhealth.io/","https://wildflowerhealth.io/launcher/"',
                               '"https://wildflowerhealth.io/launcher/"')
 WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://authorization.wildflowerhealth.io/","https://wildflowerhealth.io/authorization/"',
                               '"https://wildflowerhealth.io/authorization/"')
 WHERE client_id = '7277e898bee8ac81ea44788236e619a5';

UPDATE clients
   SET redirect_uris = replace(redirect_uris,
                               '"https://server-docs.wildflowerhealth.io/","https://wildflowerhealth.io/server-docs/"',
                               '"https://wildflowerhealth.io/server-docs/"')
 WHERE client_id = '664a01e8614050cd82ffe90350b81413';
