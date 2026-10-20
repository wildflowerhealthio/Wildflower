# Extractors

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs}}

**A handler reaches the server's data only through an extractor that hands it a capability.** It never takes the router state itself, so it can't open the store, mint a token or read a field of the state behind a gate's back; the source guard [`handlers_reach_the_state_only_through_capabilities`](<../Capabilities Explanation.md#item-source_guards--handlers_reach_the_state_only_through_capabilities>) fails the build if one tries.

There are three capability extractors:

- `Scoped<F>` builds `F` from the state and the claims the [session gate](<Middleware Explanation.md#item-require_valid_session>) stored, and only when those claims cover `F`'s required scopes. A token short of one is a `403` listing the scopes it lacks, and the handler never runs.
- `Authenticated<F>` builds `F` from the state and the claims whole, with no gate beyond the session gate: for a caller acting on its own session, logging out or reading its own scopes.
- [`Live<F>`](#item-Live) builds `F` from the state alone, with no gate at extraction.

`Scoped` and `Authenticated` come from the shared `scope-capabilities-rust` crate. Both fail closed with a `500` when they find no claims, since that means a route was mounted without its gate. `Live` lives here, beside [`LauncherPages`](#item-LauncherPages), which hands a handler the one piece of configuration it may need.

## `http::extractors::live`

### `Live`

**The door to the capabilities no principal unlocks.** The front door's capabilities, starting an authorization, exchanging a code, pairing a browser, verifying a token, serve callers who hold no bearer yet. Their gate is not a scope: it is the proof their methods demand (an [authenticated client](<../Authority/Authenticated Client Explanation.md>), a redeemable code), checked when the method is called. `F` is built through its `FromState`, on the [Live Bindings](<../Assembly/Live Bindings Explanation.md>) page.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs Live}}

#### `from_request_parts`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs Live::from_request_parts}}

## `http::extractors::launcher_pages`

### `LauncherPages`

**Where a handler sends a browser that leaves the server's pages**: the hosted launcher. Logout and sign-out both end at its root. The server serves its own pages (the wait page, the consent card, the device page), so the launcher's root is the only place outside it a handler needs to name.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs LauncherPages}}

#### `root_url`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs LauncherPages::root_url}}

#### `from_request_parts`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs LauncherPages::from_request_parts}}
