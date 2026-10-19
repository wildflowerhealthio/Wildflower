# Extractors

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs}}

**A handler reaches the server's data only through an extractor that hands it a capability.** It never takes the router state itself, so it can't open the store, mint a token or read a field of the state behind a gate's back; the source guard [`handlers_reach_the_state_only_through_capabilities`](<../Capabilities Explanation.md#handlers_reach_the_state_only_through_capabilities>) fails the build if one tries.

There are three capability extractors. `Scoped<F>` and `Authenticated<F>`, for the `/authorization` routes, come from the shared `scope-capabilities-rust` crate and read the claims the [session gate](<Middleware Explanation.md#require_valid_session>) stored (see [HTTP](<../HTTP Explanation.md>)). The third, [`Live<F>`](#live), lives here, beside [`LauncherPages`](#launcherpages), which hands a handler the one piece of configuration it may need. `mod.rs` only declares and re-exports the two.

## `Live`

**The door to the capabilities no principal unlocks.** The front door's capabilities, starting an authorization, exchanging a code, pairing a browser, verifying a token, serve callers who hold no bearer yet. Their gate is not a scope: it is the proof their methods demand (an authenticated client, a redeemable code), checked when the method is called. `Live<F>` builds `F` from the state alone, through `F`'s [`FromState`](<../Assembly/Live Bindings Explanation.md>), and never refuses; it derefs to `F`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs Live}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/extractors/live.rs Live::from_request_parts}}

No unit test here; every `/oauth` integration test goes through it, starting with [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>).

## `LauncherPages`

**Where a handler sends a browser that leaves the server's pages**: the hosted launcher. Logout and sign-out both end at its root. The server serves its own pages (the wait page, the consent card, the device page), so the launcher's root is the only place outside it a handler needs to name. Taking it as an extractor keeps the handler from reaching into the state for the configured base.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs LauncherPages}}

## `root_url`

The launcher's root, naming no server.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/extractors/launcher_pages.rs LauncherPages::root_url}}

No unit test here; exercised end to end by [`logout_redirects_to_the_launcher_without_cookies`](<../Integration Tests/Bearer Only Explanation.md#logout_redirects_to_the_launcher_without_cookies>) and [`signing_out_revokes_the_cookie_s_session_and_clears_it`](<../Integration Tests/Browser Sessions Explanation.md#signing_out_revokes_the_cookie_s_session_and_clears_it>).
