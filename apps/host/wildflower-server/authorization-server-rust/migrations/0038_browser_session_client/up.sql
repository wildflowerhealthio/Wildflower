-- One browser-session client and one cookie for every browser the server signs
-- in, the Owner's and, later, a browser the Owner approves.
--
-- Re-key the client the browsers' tokens are issued to from
-- `wildflower-owner-browser` to `wildflower-browser`, named `Wildflower
-- Browsers`. `ensure_essential_clients` upserts it on every boot under the new
-- id, so without this the old row would linger beside it as an ordinary
-- client, one the Owner could disable. Every table that names a client is
-- re-keyed with it, as in `0033_rekey_host_app_client`; nothing references
-- `clients(client_id)` with a foreign key, so each is a plain update.
UPDATE clients
   SET client_id = 'wildflower-browser',
       name = 'Wildflower Browsers'
 WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_requests SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_codes SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';
UPDATE authorization_code_grants SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';
UPDATE device_grants SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';
UPDATE refresh_token_families SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';
UPDATE launch_contexts SET client_id = 'wildflower-browser' WHERE client_id = 'wildflower-owner-browser';

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
