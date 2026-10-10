-- Restore `0013`'s `wildflower-react` client (see up.sql).
UPDATE clients
   SET client_id = 'wildflower-react',
       name = 'Wildflower Owner Console',
       redirect_uris = replace(redirect_uris,
                               '"https://wildflowerhealth.io/launcher/"',
                               '"https://wildflowerhealth.io/app/"')
 WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE authorization_requests SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE authorization_codes SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE authorization_code_grants SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE device_grants SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE refresh_token_families SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
UPDATE launch_contexts SET client_id = 'wildflower-react' WHERE client_id = '03a513940b52f8c2649a5366d1a26d19';
