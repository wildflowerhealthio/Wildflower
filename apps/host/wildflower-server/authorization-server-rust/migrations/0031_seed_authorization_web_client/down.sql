-- Reverse of up.sql. A grant or token issued to the client would outlive it,
-- so they go first, as in `0027_remove_web_trace_clients`.
DELETE FROM authorization_requests WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM authorization_codes WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM authorization_code_grants WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM device_grants WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM refresh_tokens
 WHERE family_id IN (SELECT family_id FROM refresh_token_families
                      WHERE client_id = '7277e898bee8ac81ea44788236e619a5');
DELETE FROM refresh_token_families WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM launch_contexts WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
DELETE FROM clients WHERE client_id = '7277e898bee8ac81ea44788236e619a5';
