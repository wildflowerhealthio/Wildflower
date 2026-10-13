-- Bring the Medications and Web Trace OAuth clients to their intended end state
-- on any install, however they got here.
--
-- WHY THIS EXISTS. `0006_rename_first_party_app_clients` renames
-- `wildflower-medication` -> `medications-app` (and `wildflower-web-trace` ->
-- `web-trace-app`), adding the absolute Pages redirect URI at the same time. It
-- is written as defensive SQL — `UPDATE ... WHERE client_id = '<old>' AND NOT
-- EXISTS (SELECT 1 FROM clients WHERE client_id = '<new>')` — because a failed
-- migration aborts the whole store open. The cost of that defensiveness is that
-- an install whose rows were not in the exact expected shape gets a **silent
-- no-op**: the client stays `wildflower-medication` with `redirect_uris =
-- '["/"]'`, while `apps/medications-app/src/config.ts` authorizes as
-- `medications-app` with `redirect_uri =
-- https://wildflowerhealth.io/medications-app/`. Neither the client id nor the
-- redirect URI resolves, so every launch is refused at the authorize endpoint.
--
-- Contrast `0008_seed_wildflower_importer_client`, which seeds `importer-app`
-- with its Pages redirect URI in one unconditional statement and is therefore
-- correct on every install — which is why the Importer launches where
-- Medications does not.
--
-- WHY NOT `INSERT OR REPLACE`. `INSERT OR REPLACE` is a DELETE followed by an
-- INSERT, and `refresh_token_families` / `authorization_codes` and friends carry
-- `client_id`; replacing a live row would take their rows with it (or fail the
-- constraint). Each app is repaired in three ordered, individually-guarded
-- statements instead — rename if only the old row is there, create if neither
-- is, then correct the redirect URIs whichever path was taken. Every statement
-- is a no-op on an install that is already correct, so this migration is
-- idempotent and safe to land on a healthy database.
--
-- `allowed_scopes` deliberately keeps `launch/patient` alongside `launch`: it is
-- what `standaloneSmartConfig` requests for the connect-menu flow, and the
-- requested set must be a subset of the allowed set.

-- === Medications ===

-- 1. The intended path, retried: rename the original row when it is still here
--    and the target id is free.
UPDATE clients
   SET client_id = 'medications-app',
       redirect_uris = '["/","https://wildflowerhealth.io/medications-app/"]'
 WHERE client_id = 'wildflower-medication'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'medications-app');

-- 2. Neither id present (the original seed never ran, or the row was removed):
--    create the client outright, in the shape 0004 + 0006 would have produced.
INSERT INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
SELECT
    'medications-app',
    'Medications',
    'public',
    '["/","https://wildflowerhealth.io/medications-app/"]',
    '["launch","launch/patient","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs"]',
    '["authorization_code","refresh_token"]',
    NULL,
    '2024-01-01 00:00:00+00:00',
    NULL
 WHERE NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'medications-app');

-- 3. The row exists under the right id but predates the Pages redirect URI (it
--    was renamed by hand, or 0006 ran against an already-renamed row). Add it
--    without disturbing anything else on the row.
UPDATE clients
   SET redirect_uris = '["/","https://wildflowerhealth.io/medications-app/"]'
 WHERE client_id = 'medications-app'
   AND redirect_uris NOT LIKE '%https://wildflowerhealth.io/medications-app/%';

-- === Web Trace ===
-- The same three steps; it was renamed by the same migration and so carries the
-- same latent gap.

UPDATE clients
   SET client_id = 'web-trace-app',
       redirect_uris = '["/","https://wildflowerhealth.io/web-trace-app/"]'
 WHERE client_id = 'wildflower-web-trace'
   AND NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'web-trace-app');

INSERT INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
SELECT
    'web-trace-app',
    'Web Trace',
    'public',
    '["/","https://wildflowerhealth.io/web-trace-app/"]',
    '["launch","openid","fhirUser","system/DocumentReference.read"]',
    '["authorization_code","refresh_token"]',
    NULL,
    '2024-01-01 00:00:00+00:00',
    NULL
 WHERE NOT EXISTS (SELECT 1 FROM clients WHERE client_id = 'web-trace-app');

UPDATE clients
   SET redirect_uris = '["/","https://wildflowerhealth.io/web-trace-app/"]'
 WHERE client_id = 'web-trace-app'
   AND redirect_uris NOT LIKE '%https://wildflowerhealth.io/web-trace-app/%';
