-- Seed the medication-sponsorship SMART app's OAuth client (same pattern and
-- column formats as 0003_seed_sample_clients; see `db/clients.rs`). A public
-- PKCE client — the app is a browser SMART app with no client secret.
--
-- The app is a self-hosted bundle the host serves at its own loopback origin
-- `http://127.0.0.1:8090/` (the port seeded in apps migration
-- 0003_seed_medication_sponsorship_app), so the SMART redirect back from
-- `launch.html` lands at that origin root — the sole registered `redirect_uris`
-- entry. (A launch forwarded through the tunnel would use the app's
-- `https://<subdomain>.<public_host>/` origin instead; register that as an
-- additional redirect URI per deployment if tunneled launch is needed.)
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
        '["http://127.0.0.1:8090/"]',
        '["launch","openid","fhirUser","patient/Patient.read","patient/MedicationRequest.read","patient/Medication.read","system/MedicationRequest.read","system/Medication.read"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
