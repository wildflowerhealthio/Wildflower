-- Seed the medication-sponsorship SMART app's OAuth client (same pattern and
-- column formats as 0003_seed_sample_clients; see `db/clients.rs`). A public
-- PKCE client — the app is a browser SMART app with no client secret.
--
-- The app is a self-hosted bundle served from its own origin, which differs by
-- launch: `http://127.0.0.1:8090/` on the device, or
-- `https://<subdomain>.<public_host>/` through the tunnel — and the tunnel host
-- isn't known at seed time. So `redirect_uris` is the single **app-relative**
-- entry `"/"` (a leading-`/` path): at `/authorize` gatekeeper resolves it
-- against the app's own origin for the request's provenance (see
-- `RegisteredRedirectUri` and `validate_redirect_url`), covering both launch
-- origins without naming a per-deployment host. The SMART redirect back from
-- `launch.html` lands at that origin root.
--
-- `allowed_scopes` mirrors what the app requests: EHR launch + patient context,
-- then read the patient plus their MedicationRequests and any referenced
-- Medication resources. The `system/` scopes cover a launch with no patient in
-- context, where the app reads MedicationRequests across every patient the
-- granted scopes expose.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'medication-sponsorship',
        'Sponsored Medications',
        'public',
        '["/"]',
        '["launch","openid","fhirUser","patient/Patient.read","patient/MedicationRequest.read","patient/Medication.read","system/MedicationRequest.read","system/Medication.read"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
