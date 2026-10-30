# Setup

{{#covers apps/host/wildflower-server/authorization-server-rust/src/lib.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/config.rs}}

The authorization server isn't a process of its own. It is one slice of the Wildflower host, and **the host builds it once, at boot, with one call**: [`setup_authorization_server`](#item-setup_authorization_server). The host hands over what only it has: the shared database, the shared revocation store, its configuration, a channel to hear about the Owner prompt on, and its say over how fast requests may start. It gets back a router to merge, the shared state its own gates need, and four in-process handles.

This page is that seam: the configuration, the constants that name the server's own clients and the Owner's authority, the call itself, the background sweeps it starts, and what the crate root re-exports for the host.

## `config`

{{#item apps/host/wildflower-server/authorization-server-rust/src/config.rs self}}

### `AuthorizationServerConfig`

{{#item apps/host/wildflower-server/authorization-server-rust/src/config.rs AuthorizationServerConfig}}

## `crate`

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs self}}

### The server's own clients

Two clients are **essential** (see [`is_essential_client`](<../Domain/Client Explanation.md#item-is_essential_client>)): the Owner could not get in without them, so neither can be disabled. [Seeding](<Seeding Explanation.md>) rewrites both on every boot.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs WILDFLOWER_HOST_APP_CLIENT_ID}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs default_host_app_client_scopes}}

**Every signed-in browser's token is issued to the browser-session client.** So revoking this subject signs every browser out, while one browser is signed out by revoking its session (its token's `sid`) or its token's `jti`. Neither sign-in nor pairing is an OAuth flow, so the client is seeded with no grant type, and `/oauth/token` never mints its token.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs BROWSER_SESSION_CLIENT_ID}}

### The Owner's authority

**A token covering the widest scopes covers every per-resource scope an `/authorization` route asks for**, so the Owner passes every gate. The Owner's scopes add `wildflower/launch`, which is a known scope rather than a resource scope, so the `wildflower/*` wildcard doesn't cover it and it has to be listed.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs WILDFLOWER_WIDEST_SCOPES}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs OWNER_SCOPES tests="tests::the_owner_s_scopes_cover_the_widest_scopes"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs owner_scopes}}

### `setup_authorization_server`

**Build the server over the host's database, and start it working.** In order:

1. **Open and seed the store** ([`open_and_seed_store`](<Seeding Explanation.md#item-open_and_seed_store>)): run the migrations, make sure a signing key is active, and rewrite the server's own clients.
2. **Build the shared state** ([`AuthorizationServerState`](<Live Bindings Explanation.md#item-AuthorizationServerState>)) from the config, with the [run's start](<../Domain/Browser Session Explanation.md#item-RunStart>): when the run started, and the Owner sessions it carries over from earlier runs, those the host's launch views still open signed in, whose sign-in codes it is handed, whichever run minted them. No other Owner session an earlier run signed in is live under the run, so the start writes nothing for them, and a store that can't be written then doesn't keep the server from starting. Paired sessions stand.
3. **Publish the [Owner prompt](<../Domain/Owner Prompt Explanation.md>)** on `owner_approval_tx`. The channel's value doesn't survive a restart, but the row does, so a request left pending across a restart is in the server's first status, and the host notifies about it.
4. **Start the background sweeps** below.
5. **Build the router**, whose routes are at `/.well-known/jwks.json`, `/oauth/*` and `/authorization/*`. The host merges it as it is.
6. **Build the in-process handles** the host keeps.

The host builds `revocation_store` once and passes the same store to the FHIR server's adapter, so **the authorization server's gates and the FHIR server read one denylist**. Where no visitor can reach the server, the host passes [`AdmitEveryAuthorizationStart`](<Ports and Adapters Explanation.md#item-AdmitEveryAuthorizationStart>) as the start gate.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs setup_authorization_server}}

Every integration test starts from it, through the harness's [`spin_up`](<../Integration Tests/Test Fixtures Explanation.md#item-spin_up>).

### `AuthorizationServer`

The handles it holds are [`LaunchContextMinter`](<OAuth Bindings Explanation.md#item-LaunchContextMinter>), [`SameDeviceSignInCodeMinter`](<OAuth Bindings Explanation.md#item-SameDeviceSignInCodeMinter>), [`PendingConsentWatcher`](<OAuth Bindings Explanation.md#item-PendingConsentWatcher>) and [`InProcessTokenVerifier`](<Session Bindings Explanation.md#item-InProcessTokenVerifier>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs AuthorizationServer}}

### The background sweeps

`setup_authorization_server` starts three loops on the runtime. **None changes what the server honours**: each either reclaims rows the read paths already refuse, or republishes what the store already says. After a long pause such as a suspend, each runs once rather than catching up on the ticks it missed.

The reaper republishes the Owner prompt, because republishing otherwise happens only after a write, and an idle server would go on advertising a request that has expired.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs DEVICE_CONSENT_REAPER_INTERVAL}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_device_consent_reaper}}

The retention sweep applies [`purge_expired`](<../Domain/Retention Explanation.md#item-purge_expired>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs RETENTION_SWEEP_INTERVAL}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_retention_sweep}}

The revocation purge only reclaims space, because an expired token is refused anyway. Its floor is [`LONGEST_BROWSER_SESSION_TTL`](<../Domain/Browser Session Explanation.md#item-LONGEST_BROWSER_SESSION_TTL>), the longest any token minted here lives, so a row is never dropped while its token could still be live.

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs REVOCATION_PURGE_INTERVAL}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_revocation_purge}}

### What the crate root re-exports

The host imports the crate root, not its modules. Beyond the items above, the root re-exports:

- **the store**: `SqliteGrantStore`, the persistence port `GrantStore` and `GrantTx`, and `DieselPool`, so the host can name the pool type without depending on diesel;
- **the Owner prompt**: [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>), what the host is told about, and [`ConsentKey`](<../Domain/Owner Prompt Explanation.md#item-ConsentKey>), what it waits on;
- **the gates and cookies**: `authorization_server_auth_middleware` and `AuthorizationServerAuthMiddleware`, `ensure_bearer_header`, `AuthorizationServerState`, and the browser-session cookie's name, header and helpers;
- **the in-process handles**: `LaunchContextMinter`, `SameDeviceSignInCodeMinter`, `PendingConsentWatcher`, `InProcessTokenVerifier`;
- **the start gate**: `AuthorizationStartGate`, which the host implements, and `AdmitEveryAuthorizationStart`;
- `grantable_admin_scopes`, every admin scope the `/authorization` surface enforces;
- in debug builds only, [`seed_dev_app_clients`](<Seeding Explanation.md#item-seed_dev_app_clients>).

The modules `config`, `crypto_util`, `db`, `domain` and `http` stay public too: the integration tests reach into some of them, and the crate's public doc links point into them.
