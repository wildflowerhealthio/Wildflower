# Seeding

{{#covers apps/host/wildflower-server/authorization-server-rust/src/seeding.rs}}

**Some rows must exist before anyone can ask for anything**: a key to sign tokens with, and the server's own clients. Seeding writes them at every boot, and is safe to run again. The signing key is inserted only when no key is active, and never rotated. The server's own clients are **upserted**: rewritten to match the code every boot, so their registrations follow the host's configuration and a store written by another build is corrected. An upsert keeps a row's registration time and any disable the Owner set.

The bundled SMART sample apps' clients are static, so a migration seeds them instead (`0003_seed_sample_clients`). Seeding in code is kept for what depends on the running host: the configured scopes and origin, and a freshly generated key.

A debug build also seeds a client for each first-party app's local dev server. Release builds contain no code that could write them.

## `seeding`

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs self}}

### `open_and_seed_store`

[`setup_authorization_server`](<Setup Explanation.md#item-setup_authorization_server>) calls it first, and the server doesn't start if it fails. A key is generated before the write scope opens, because generating an RSA key is slow.

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs open_and_seed_store}}

#### `ensure_some_active_signing_key`

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_some_active_signing_key}}

#### `ensure_essential_clients`

The two [essential clients](<Setup Explanation.md#the-servers-own-clients>) are server-defined, public, and have no redirect URIs. The browser-session client has no grant type: its tokens are minted only at `/oauth/sign-in` and by the pairing page's poll, and neither is an OAuth flow.

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_essential_clients tests="tests::seeds_the_host_app_s_client_with_the_configured_scopes tests::the_default_host_app_s_client_is_allowed_openid_only tests::seeds_the_browser_session_client_with_the_owner_s_scopes"}}

#### `ensure_fhir_ui_client`

**The FHIR server's web UI signs its users in here** with the authorization-code flow, so its client follows the server's origin.

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_fhir_ui_client tests="tests::seeds_the_fhir_ui_client_for_this_servers_origin tests::the_clients_seeding_owns_are_server_defined"}}

### `seed_dev_app_clients`

**Debug builds only: a client for each first-party app's local dev server.** The first-party apps ship from the published site, and their clients register its redirect. A debug build also gets a dev tile per app, whose launch URL points at the app's vite dev server on `localhost`, and that launch needs a client whose redirect is that exact loopback address. Each dev client is a separate client under its own id, because adding a plaintext loopback redirect to the production client would register it on a client a public website uses.

- **Ports come from the shared `dev-app-ports.json`**, embedded at compile time. The apps' dev seed and each app's `vite.config.ts` read the same file, so a redirect can't drift off the port its dev server listens on.
- **The redirect is the origin root**, except the OHIF viewer's, whose launch lands on `/fhir-viewer`, since redirect matching is exact.
- **Scopes mirror each app's production client**, which is what a dev build of the app asks for.
- **It is code, not a migration**, because migrations run in release databases too. The function, and its one call in the Tauri host, are compiled only into debug builds.
- **It upserts**, so a change to a definition lands on the next boot. They are trusted on first use, like any app the Owner approved.

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs seed_dev_app_clients}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs DEV_APP_PORTS_JSON}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs DevAppPorts}}

#### The scopes each dev client is allowed

Each app's test reads the app's own `config.ts`, the one place the app writes its scope string and client ids. A scope added on one side alone fails here, rather than at `/authorize` on a real device.

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs PLOTS_DEV_SCOPES tests="tests::seeds_the_plots_dev_client_with_the_apps_own_scopes"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs SYNTHETIC_DATA_DEV_SCOPES tests="tests::seeds_the_synthetic_data_dev_client_with_the_apps_own_scopes"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs MEDICATIONS_DEV_SCOPES tests="tests::seeds_the_medications_dev_client_with_the_apps_own_scopes"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/seeding.rs STRENGTH_DEV_SCOPES tests="tests::seeds_the_strength_dev_client_with_the_apps_own_scopes"}}
