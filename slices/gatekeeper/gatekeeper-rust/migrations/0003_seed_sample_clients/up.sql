-- Seed the bundled SMART sample-app OAuth clients in SQL (the same pattern the
-- apps slice uses to seed its registry), replacing the per-boot Rust upsert that
-- used to register them. Run-once, like every migration — so unlike the old Rust
-- path it does not re-apply on each boot to correct a drifted definition; a
-- definition change ships as a new migration.
--
-- The first-party host client + the signing key are still seeded in Rust
-- (`seeding.rs`): they depend on runtime config (the host's granted scopes) and
-- on key generation, neither of which a static SQL seed can express.
--
-- Column formats must match what the store's read path expects (see
-- `db/clients.rs`): `kind` is the lowercase `ClientKind` discriminant; the three
-- list columns are compact JSON (the serde form the db layer's JSON TEXT
-- newtypes read), with `allowed_grant_types` using the renamed wire values;
-- `registered_at` is a `DateTime<Utc>` text diesel's chrono mapping parses
-- (`%F %T%:z`). `INSERT OR IGNORE` keeps this idempotent against a dev store
-- an older build already populated via the Rust seeder (the row is left as-is
-- rather than conflicting).

INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash, registered_at, disabled_at)
VALUES
    (
        'growth_chart',
        'SMART Growth Chart (sample)',
        'public',
        '["https://examples.smarthealthit.org/growth-chart-app/"]',
        '["openid","profile","fhirUser","launch","launch/patient","patient/Observation.read","patient/Patient.read","offline_access"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    ),
    -- The Medication Viewer cloud app (apps migration 004) points its `client_id`
    -- here. `my_web_app` is the registration the MITRE SMART-on-FHIR demo presents.
    (
        'my_web_app',
        'Medication Viewer (SMART sample)',
        'public',
        '["https://mitre.github.io/smart-on-fhir-demo/index.html"]',
        '["launch","openid","fhirUser","patient/*.read"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    ),
    (
        'cc344727-6f90-496c-94fd-c7829aa9a51d',
        'PRECISE-HBR Risk Calculator',
        'public',
        '["https://hbr.alumicoin.cloud/callback"]',
        '["openid","fhirUser","launch","profile","patient/Patient.rs","patient/Observation.rs","patient/Condition.rs","patient/MedicationRequest.rs","patient/Procedure.rs"]',
        '["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL
    );
