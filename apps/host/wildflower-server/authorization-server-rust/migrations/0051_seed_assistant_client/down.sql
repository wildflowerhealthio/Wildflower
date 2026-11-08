-- Reverse of up.sql. A request, grant or token naming the client would outlive
-- it, so they go first, as in `0031_seed_authorization_web_client`, from every
-- table that names a client.
DELETE FROM code_authorization_requests WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM user_code_requests WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM session_widening_requests WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM session_shortfall_acknowledgements WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM authorization_codes WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM authorization_code_grants WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM device_grants WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM refresh_tokens
 WHERE family_id IN (SELECT family_id FROM refresh_token_families
                      WHERE client_id = '9883d102933b1561e343cae5fd9f26eb');
DELETE FROM refresh_token_families WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM launch_contexts WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
DELETE FROM clients WHERE client_id = '9883d102933b1561e343cae5fd9f26eb';
