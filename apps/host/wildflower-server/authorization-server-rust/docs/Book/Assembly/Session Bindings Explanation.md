# Session Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs}}

These bindings are about the caller's own token. **The token verifier** is what every gate runs to turn a bearer into verified claims, and the host's FHIR server runs the same one in-process. The rest act on the caller's own browser session or token: record that a browser's cookie was used, end a browser's own session at sign-out, and the two self-service `/authorization` capabilities, which need a verified token and no scope.

## `LiveTokenVerifier`

**Verify a presented access token**: signed with one of the stored keys, unexpired, naming this server's origin as `iss` and `aud`, and not revoked. Built from the state for the two bearer gates, over the store (for the keys and the browser session a token names), the revocation check, and the origin ([Token Verifier](<../Capabilities/Session/Token Verifier Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveTokenVerifier}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveTokenVerifier::from_state}}

## `InProcessTokenVerifier`

**The token verifier, handed to the host**, so the FHIR server verifies each bearer exactly as this server's own gates do, without a network hop. Cheap to clone. Built once by [`setup_authorization_server`](<Setup Explanation.md#setup_authorization_server>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier::new}}

No unit test of its own.

## `verify`

A token that doesn't pass is `TokenRejected` or `Revoked`. A key or revocation store that can't be read is an error too, so verification **fails closed** ([`VerifyError`](<../Domain/Token Explanation.md#verifyerror>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier::verify}}

Exercised end to end by [`revoking_a_session_stops_its_authorization_and_fhir_requests`](<../Integration Tests/Browser Sessions Explanation.md#revoking_a_session_stops_its_authorization_and_fhir_requests>), which checks a revoked session's token is refused by the in-process verifier as well as by `/authorization`.

## `LiveBrowserSessionUseRecorder`

**Record that a browser's session was used**, moving its last-seen time. Built by `record_browser_session_cookie_use`, which the host's cookie-to-bearer layer calls once it has accepted the cookie, over the store and the last-seen throttle, so a page load's many requests write once ([Browser Session Use Recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionUseRecorder}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionUseRecorder::from_state}}

## `LiveBrowserSessionEnder`

**End a browser's own browser session** at `/oauth/sign-out`, over the claims of the browser's own cookie. Built over the store ([Browser Session Ender](<../Capabilities/Session/Browser Session Ender Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionEnder}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionEnder::from_state}}

## `LiveSessionEnder`

**Logout's self-revoke**: denylist the caller's own token. Acquired through `Authenticated<LiveSessionEnder>`, which hands `build` the caller's verified claims, so it can revoke nothing but the token presented. Built over the revocation port and those claims ([Session Ender](<../Capabilities/Session/Session Ender Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionEnder}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionEnder::build}}

## `LiveSessionReader`

**A caller reads back its own session**: its scopes, its `sid`, and when its browser session expires. Acquired through `Authenticated<LiveSessionReader>` by `GET /authorization/session`, and by the browsers list for the caller's own `sid`. Built over the store and the caller's claims ([Session Reader](<../Capabilities/Session/Session Reader Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionReader::build}}

The other bindings have no test of their own; the routes and gates that build them are exercised end to end, as the [Session Routes](<../HTTP/Routes/Session Routes Explanation.md>) and [Middleware](<../HTTP/Middleware Explanation.md>) pages show.
