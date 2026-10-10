-- Seed the Web Trace SMART app's OAuth client (same pattern and column formats
-- as 0003_seed_sample_clients / 0004_seed_wildflower_medication_client; see
-- `db/clients.rs`). A public PKCE client — the app is a browser SMART app with
-- no client secret, so `secret_hash` stays NULL. `disabled_at` NULL: the client
-- ships enabled, and only an admin disable ever writes it.
--
-- The app is a self-hosted bundle served from its own origin, which differs by
-- launch: `http://127.0.0.1:8091/` on the device, or
-- `https://<subdomain>.<public_host>/` through the tunnel — and the tunnel host
-- isn't known at seed time. So `redirect_uris` is the single **app-relative**
-- entry `"/"` (a leading-`/` path): at `/authorize` gatekeeper resolves it
-- against the app's own origin for the request's provenance (see
-- `RegisteredRedirectUri` and `validate_redirect_url`), covering both launch
-- origins without naming a per-deployment host. The SMART redirect back from
-- `launch.html` lands at that origin root.
--
-- `allowed_scopes` mirrors what the app requests, and is deliberately **read-only**
-- — the viewer reviews and exports existing recordings, it never writes FHIR. The
-- one resource scope is `system/DocumentReference.read` rather than a `patient/`
-- scope because trace `DocumentReference`s carry no `subject`: they record a
-- browsing session, not a clinical fact about a person, so they are unreachable
-- through patient context and a `patient/` scope would match nothing.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'wildflower-web-trace',
        'Web Trace',
        'public',
        '["/"]',
        '["launch","openid","fhirUser","system/DocumentReference.read"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
