-- Remove the Web Trace app's OAuth clients, `web-trace-app` and the debug-only
-- `web-trace-app-dev`. `apps/web-trace` is deleted, so nothing authorizes as
-- either. The apps half, which deletes the tiles, is apps migration
-- `0018_remove_web_trace_app`.
--
-- Nothing references `clients(client_id)` with a foreign key (see
-- `0026_rekey_launcher_client`), so every table that names a client is cleared
-- first: an outstanding grant or refresh token for a deleted client must not
-- outlive it. A family's `refresh_tokens` go before the family, which they
-- reference without `ON DELETE CASCADE`.
DELETE FROM authorization_requests WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM authorization_codes WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM authorization_code_grants WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM device_grants WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM refresh_tokens
 WHERE family_id IN (SELECT family_id FROM refresh_token_families
                      WHERE client_id IN ('web-trace-app', 'web-trace-app-dev'));
DELETE FROM refresh_token_families WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM launch_contexts WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
DELETE FROM clients WHERE client_id IN ('web-trace-app', 'web-trace-app-dev');
