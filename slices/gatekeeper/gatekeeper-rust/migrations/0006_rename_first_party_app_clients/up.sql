-- Rename the two first-party SMART apps' OAuth clients and widen their redirect
-- allowlists to cover the deployed GitHub Pages origin.
--
--   wildflower-medication -> medications-app
--   wildflower-web-trace  -> web-trace-app
--
-- The gatekeeper half of apps migration `0005_first_party_apps_to_cloud`, which
-- renames the matching `app_registrations` rows (id AND `client_id`) and flips
-- them to cloud rows served from <https://wildflowerhealth.io>. The two ids MUST
-- stay equal: the host's self-hosted redirect resolver looks an app up by
-- `client_id`, so an app-relative redirect entry only ever resolves for a client
-- whose id is also an app id.
--
-- REDIRECT URIS become two entries each:
--
--   * `"/"` — the app-relative entry (unchanged). It resolves only through the
--     self-hosted resolver, so on a production install (where the app is now a
--     *cloud* row) it resolves to nothing and matches nothing. It is kept for the
--     debug-only `medications-app-dev` / `web-trace-app-dev` self-hosted rows'
--     sibling clients and for a `down`-migrated install.
--   * the absolute Pages URL — `https://wildflowerhealth.io/medications-app/`
--     (resp. `/web-trace-app/`). A cloud app's redirect can only be absolute:
--     the app-relative form needs a self-hosted row to resolve against. Each
--     app's `launch.html` computes its redirect URI from `window.location`, so
--     the value it sends is exactly its published directory URL (trailing slash
--     included) — matched here by exact URL equality.
--
-- Column formats match 0003/0004/0005 (see `db/clients.rs`): the list columns are
-- compact JSON. Guarded with `NOT EXISTS` so an install that somehow already has
-- a client under the new id is a no-op rather than a PK conflict that would abort
-- the migration run (and with it the whole gatekeeper store open).
UPDATE clients
   SET client_id = 'medications-app',
       redirect_uris = '["/","https://wildflowerhealth.io/medications-app/"]'
 WHERE client_id = 'wildflower-medication'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'medications-app');

UPDATE clients
   SET client_id = 'web-trace-app',
       redirect_uris = '["/","https://wildflowerhealth.io/web-trace-app/"]'
 WHERE client_id = 'wildflower-web-trace'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'web-trace-app');

-- Everything issued under the OLD client ids is dropped rather than repointed.
-- `client_id` is a plain column on each of these tables (no FK), so a rename
-- would otherwise leave standing consents, live codes, and refresh-token families
-- keyed to a client that no longer exists — invisible rows that can never be
-- redeemed but still show up in the Owner UI's access index. Users re-consent on
-- the next launch; acceptable in beta, and noted in the PR that ships this.
DELETE FROM refresh_tokens
 WHERE family_id IN (
     SELECT family_id FROM refresh_token_families
      WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace')
 );
DELETE FROM refresh_token_families
 WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace');
DELETE FROM authorization_codes
 WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace');
DELETE FROM authorization_requests
 WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace');
DELETE FROM authorization_code_grants
 WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace');
DELETE FROM device_grants
 WHERE client_id IN ('wildflower-medication', 'wildflower-web-trace');
