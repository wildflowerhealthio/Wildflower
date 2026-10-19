# Seeding

{{#covers apps/host/wildflower-server/authorization-server-rust/src/seeding.rs}}

**Some rows must exist before anyone can ask for anything**: a key to sign tokens with, and the server's own clients. Seeding writes them at every boot, and is safe to run again. The signing key is inserted only when no key is active, and never rotated. The server's own clients are **upserted**, rewritten to match the code every boot, so their registrations follow the host's configuration, and a store written by another build is corrected. An upsert keeps a row's registration time and any disable the Owner set.

The bundled SMART sample apps' clients are static, so a migration seeds them instead (`0003_seed_sample_clients`). Seeding in code is kept for what depends on the running host: the configured client ids, scopes and origin, and a freshly generated key.

A debug build also seeds a client for each first-party app's local dev server; release builds contain no code that could write them.

## `open_and_seed_store`

**Open the store and make the boot-time rows true.** Opening the store runs the migrations. A key is generated only when the store has no active one, and before the write scope opens, since generating an RSA key is slow. Then one write scope ensures the key, the two essential clients and the FHIR server UI's client. [`setup_authorization_server`](<Setup Explanation.md#setup_authorization_server>) calls it first, and the server doesn't start if it fails.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs open_and_seed_store}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_some_active_signing_key}}

### The essential clients

**The host app's client and the browser-session client** are server-defined, public, and have no redirect URIs. The host app's client is registered under the configured id and allowed the configured scopes and every grant type. The browser-session client is allowed the Owner's scopes, the most any browser session may hold, and no grant type: its tokens are minted only at `/oauth/sign-in` and by the pairing page's poll, neither of which is an OAuth flow.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_essential_clients}}

### The FHIR server UI's client

**The FHIR server's web UI signs its users in here** with the authorization-code flow. Its client is public (PKCE, no secret), server-defined, may only return to `{server_origin}/ui/callback`, and is allowed `user/*.cruds`: the UI acts as the signed-in user across every resource type. It is upserted every boot, so it follows the server's origin.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_fhir_ui_client}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_host_app_s_client_under_the_configured_id}}

The host app's client is seeded under the id and scopes passed in, named "Wildflower Host", and nothing is seeded under the fallback constant's id.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::the_default_host_app_s_client_is_allowed_openid_only}}

With the standalone defaults, the host app's client may be granted `openid` alone: the Owner's authority isn't the host app's.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_browser_session_client_with_the_owner_s_scopes}}

The browser-session client is public, with no redirect URI and no grant type, and allowed exactly the Owner's scopes, whatever the host app's client is allowed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_fhir_ui_client_for_this_servers_origin}}

The UI's client is public, without a secret, returns only to the origin's `/ui/callback`, and asks for `user/*.cruds` alone.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::the_clients_seeding_owns_are_server_defined}}

**The three clients seeding owns are server-defined**, so a request is held to their registrations as they stand; a sample app the migrations seeded, `growth_chart`, is trusted on first use.

## `seed_dev_app_clients`

**Debug builds only: a client for each first-party app's local dev server.** The first-party apps ship from the published site, and their clients register its redirect. A debug build also gets a dev tile per app whose launch URL points at the app's vite dev server on `localhost`, and that launch needs a client whose redirect is that exact loopback address. FHIR Sync for Pebble has no tile, but its dev server gets a client the same way. Each dev client is a separate client under a random id, because adding a plaintext loopback redirect to the production client would register it on a client a public website uses.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs seed_dev_app_clients from="let store" to=".expect(" from="let dev_clients" to="DEV_ROOT_REDIRECT_PATH," from="for (client_id" through="for (client_id"}}

- **Ports come from the shared `dev-app-ports.json`**, embedded at compile time, the same file the apps' dev seed and each app's `vite.config.ts` read, so a redirect can't drift off the port its dev server listens on.
- **The redirect is the origin root**, except the OHIF viewer's, whose launch lands on `/fhir-viewer`: redirect matching is exact.
- **Scopes mirror each app's production client**, which is what a dev build of the app asks for.
- **It is code, not a migration**, because migrations run in release databases too. The function, and its one call in the Tauri host, are compiled only into debug builds.
- **It upserts**, so a change to a definition lands on the next boot; nothing else owns these rows. They are trusted on first use, like any app the Owner approved.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs DEV_APP_PORTS_JSON}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs DevAppPorts}}

The scope lists the tests pin to the apps' own config:

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs PLOTS_DEV_SCOPES}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs SYNTHETIC_DATA_DEV_SCOPES}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs MEDICATIONS_DEV_SCOPES}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs STRENGTH_DEV_SCOPES}}

### What it looks like

Each test reads the app's own `config.ts`, the one place the app writes its scope string and client ids, and checks it requests exactly the dev client's scopes and launches as both the dev and production clients. Then it seeds an in-memory store and reads the dev client back: public, those scopes, and the loopback root on the port `dev-app-ports.json` gives. Where the production row is seeded by a migration under the id the app names, it checks that row allows the same scopes, so a scope added on one side alone fails here rather than at `/authorize` on a real device.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_plots_dev_client_with_the_apps_own_scopes}}

Plots: the dev client, and the production client re-keyed by migration `0028`, both allow the scopes `config.ts` asks for.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_synthetic_data_dev_client_with_the_apps_own_scopes}}

The synthetic data loader: the dev client matches `config.ts`, and `config.ts` names the production client; the production row's scopes aren't read back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_medications_dev_client_with_the_apps_own_scopes}}

Medications: the dev client and the production client both allow the scopes `config.ts` asks for.

{{#code apps/host/wildflower-server/authorization-server-rust/src/seeding.rs tests::seeds_the_strength_dev_client_with_the_apps_own_scopes}}

Strength: the dev client and the production client both allow the scopes `config.ts` asks for.
