-- Seed the OAuth client of the Assistant (`apps/assistant/assistant-web`), a
-- chat with Claude over the record of a server it signs in to, published at
-- <https://assistant.wildflowerhealth.io/>. The apps half is apps migration
-- `0026_seed_assistant_app`, which seeds the `assistant` tile launching as
-- this client.
--
-- A public PKCE client: a static browser page keeps no secret, so
-- `secret_hash` stays NULL. `disabled_at` NULL: the client ships enabled. Same
-- column formats as `0031_seed_authorization_web_client` (see `db/clients.rs`).
-- Its id is random (`openssl rand -hex 16`), and its name is the one the
-- consent prompt shows.
--
-- REDIRECT URI is the app's root on its own origin,
-- `https://assistant.wildflowerhealth.io/`, where a sign-in returns. A copy
-- served anywhere else (a PR preview, the dev server) presents an unregistered
-- redirect; the debug-only `assistant-dev` client (`seeding.rs`) covers the dev
-- server.
--
-- `allowed_scopes` is exactly what the app asks for (`ASSISTANT_SCOPE` in the
-- app's `src/config.ts`; `seeding.rs`'s
-- `seeds_the_assistant_dev_client_with_the_apps_own_scopes` reads that file and
-- pins this row to it): every interaction on every resource type. The grant,
-- not this list, decides what the agent can do: the consent prompt lets the
-- Owner narrow it, and the app offers the agent only what was granted.
--
-- The refresh policy is the data apps' (`0050`): a week idle, 30 days at most,
-- outliving the browser session. Named here, as a row that names none of the
-- three columns gets the strictest policy.
--
-- `INSERT OR IGNORE`, as in `0031`, so an install that already has a client
-- under this id is a no-op rather than a PK conflict that aborts the run.
INSERT OR IGNORE INTO clients
    (client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, secret_hash,
     registered_at, disabled_at, refresh_idle_ttl_seconds, refresh_max_ttl_seconds,
     refresh_ends_with_browser_session)
VALUES
    (
        '9883d102933b1561e343cae5fd9f26eb',
        'Wildflower Assistant',
        'public',
        '["https://assistant.wildflowerhealth.io/"]',
        '["launch","openid","fhirUser","system/*.cruds"]',
        '["authorization_code","refresh_token"]',
        NULL,
        '2024-01-01 00:00:00+00:00',
        NULL,
        604800,
        2592000,
        0
    );
