-- Re-key the host app's OAuth client. Its id becomes a random one
-- (`openssl rand -hex 16`) rather than the name `wildflower-host`, and its
-- `name` becomes `Wildflower Host`.
--
-- No migration seeds this client: `ensure_essential_clients` upserts it on
-- every boot under the configured id. Without this migration an install's old
-- `wildflower-host` row would linger beside the new one as an ordinary client,
-- one the Owner could disable, and what was issued to it would stay under the
-- old id. So the row and every table that names a client are re-keyed, as in
-- `0026_rekey_launcher_client`. Nothing references `clients(client_id)` with a
-- foreign key, so each is a plain update. The next boot's seeding then narrows
-- the row's `allowed_scopes` to the host app client's own.
--
-- token-revocation-rust's per-subject `revocation_epochs` are keyed by a
-- token's `sub` and live in that slice's own migrations, so they stay put: a
-- token minted as `wildflower-host` before this ran is still checked against
-- that subject's epoch.
UPDATE clients
   SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5',
       name = 'Wildflower Host'
 WHERE client_id = 'wildflower-host';
UPDATE authorization_requests SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
UPDATE authorization_codes SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
UPDATE authorization_code_grants SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
UPDATE device_grants SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
UPDATE refresh_token_families SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
UPDATE launch_contexts SET client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5' WHERE client_id = 'wildflower-host';
