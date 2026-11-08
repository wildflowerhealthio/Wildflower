-- Seed the Assistant's homescreen tile: a chat with Claude over the record of
-- the server it launches against (`apps/assistant/assistant-web`), published at
-- the root of its own origin, <https://assistant.wildflowerhealth.io/>, as every
-- first-party app is since `0024`. The debug-only `assistant-dev` tile
-- (`apps-rust/src/dev_seed.rs`) points at the local vite dev server instead.
--
-- `client_id` is the app's OAuth client, under a random id
-- (`openssl rand -hex 16`), seeded by authorization-server-rust migration
-- `0051_seed_assistant_client`; the TS side is the app's `src/config.ts`. A
-- launch checks the caller's grant against that client's scopes.
--
-- `url` is the SMART EHR-launch template the other first-party tiles carry:
-- the app root, which reads `launch` and `iss` off its URL. Every launch
-- substitutes the server's public HTTPS origin for `{origin}`.
--
-- `INSERT OR IGNORE` and a tail `position`, as in `0019`, so an install that
-- already holds the id or uploaded an app keeps both: `position` is UNIQUE and
-- uploads allocate `MAX(position) + 1`, so a literal could collide.
INSERT OR IGNORE INTO app_registrations (id, client_id, name, subtitle, on_homescreen, position, url)
   VALUES ('assistant',
           '9883d102933b1561e343cae5fd9f26eb',
           'Wildflower Assistant',
           'Ask Claude about your record, with your own API key',
           1,
           (SELECT COALESCE(MAX(position), -1) + 1 FROM app_registrations),
           'https://assistant.wildflowerhealth.io/?launch={launch}&iss={origin}');
