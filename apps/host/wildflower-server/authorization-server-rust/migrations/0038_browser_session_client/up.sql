-- One browser-session client and one cookie for every browser the server signs
-- in, the Owner's and, later, a browser the Owner approves.
--
-- Re-key the client the browsers' tokens are issued to. Its id becomes a
-- random one (`openssl rand -hex 16`) rather than the name
-- `wildflower-owner-browser`, and its `name` becomes `Wildflower Browsers`.
--
-- No migration seeds this client: `ensure_essential_clients` upserts it on
-- every boot under the new id. Without this migration an install's old
-- `wildflower-owner-browser` row would linger beside the new one as an
-- ordinary client, one the Owner could disable, and what was issued to it
-- would stay under the old id. So the row and every table that names a client
-- are re-keyed, as in `0033_rekey_host_app_client`. Nothing references
-- `clients(client_id)` with a foreign key, so each is a plain update.
UPDATE clients
   SET client_id = 'cb9bbe139845cae9654b7909d60d274f',
       name = 'Wildflower Browsers'
 WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_requests SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_codes SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_code_grants SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';
UPDATE device_grants SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';
UPDATE refresh_token_families SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';
UPDATE launch_contexts SET client_id = 'cb9bbe139845cae9654b7909d60d274f' WHERE client_id = 'wildflower-owner-browser';

-- Whether a request can be decided in the browser that made it: that browser
-- carried a browser session when `/oauth/authorize` parked the request, so it
-- was sent to the consent card itself, and the host neither notifies for nor
-- opens it.
ALTER TABLE authorization_requests
    RENAME COLUMN requested_by_owner_browser TO decidable_in_requesting_browser;

-- End every standing Owner session. The cookie it rode in is no longer read,
-- so the Owner signs in again; revoking the session also ends the tokens,
-- codes and refresh families minted under it. Timestamps are the diesel chrono
-- text encoding (`%F %T%.f%:z`).
UPDATE browser_sessions
   SET revoked_at = strftime('%Y-%m-%d %H:%M:%f', 'now') || '+00:00'
 WHERE kind = 'owner' AND revoked_at IS NULL;
