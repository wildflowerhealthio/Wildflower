-- Restore the OHIF viewer's client ids from before `0029` (see up.sql).
UPDATE clients SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE authorization_requests SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE authorization_codes SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE authorization_code_grants SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE device_grants SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE refresh_token_families SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';
UPDATE launch_contexts SET client_id = 'ohif-viewer' WHERE client_id = '941de68e6b59eb9dcc32df8ede89e636';

UPDATE clients SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE authorization_requests SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE authorization_codes SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE authorization_code_grants SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE device_grants SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE refresh_token_families SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
UPDATE launch_contexts SET client_id = 'ohif-viewer-dev' WHERE client_id = 'f9866f7b1d0d8505dc65ef4f749664b5';
