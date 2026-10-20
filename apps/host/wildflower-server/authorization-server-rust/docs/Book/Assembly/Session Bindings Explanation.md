# Session Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs}}

These bindings are about the caller's own token. **The token verifier** is what every gate runs to turn a bearer into verified claims, and the host's FHIR server runs the same one in-process. The rest act on the caller's own browser session or token, and the two `/authorization` self-service capabilities need a verified token but no scope.

## `live_bindings::session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs self}}

### `LiveTokenVerifier`

The [token verifier](<../Capabilities/Session/Token Verifier Explanation.md>), over the store, the revocation check and the origin.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveTokenVerifier}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveTokenVerifier::from_state}}

### `InProcessTokenVerifier`

**The token verifier, handed to the host**, so the FHIR server verifies each bearer exactly as this server's own gates do, without a network hop. [`setup_authorization_server`](<Setup Explanation.md#item-setup_authorization_server>) builds it once.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier::new}}

#### `verify`

Verification **fails closed**: a key or revocation store that can't be read is an [`AccessTokenVerifyError`](<../Domain/Access Token Explanation.md#item-AccessTokenVerifyError>) too. The [Browser Sessions](<../Integration Tests/Browser Sessions Explanation.md>) tests check that a revoked session's token is refused here as well as at `/authorization`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs InProcessTokenVerifier::verify}}

### `LiveBrowserSessionUseRecorder`

The [browser session use recorder](<../Capabilities/Session/Browser Session Use Recorder Explanation.md>), over the store and the last-seen throttle, so a page load's many requests write once.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionUseRecorder}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionUseRecorder::from_state}}

### `LiveBrowserSessionEnder`

The [browser session ender](<../Capabilities/Session/Browser Session Ender Explanation.md>), over the store.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionEnder}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveBrowserSessionEnder::from_state}}

### `LiveSessionEnder`

The [session ender](<../Capabilities/Session/Session Ender Explanation.md>). `Authenticated<LiveSessionEnder>` hands `build` the caller's verified claims, so **it can revoke nothing but the token presented**.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionEnder}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionEnder::build}}

### `LiveSessionReader`

The [session reader](<../Capabilities/Session/Session Reader Explanation.md>), over the store and the caller's claims, so it can read nothing but the caller's own session.

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionReader}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/live_bindings/session.rs LiveSessionReader::build}}

These bindings have no unit tests of their own. The [Session Routes](<../HTTP/Routes/Session Routes Explanation.md>) and [Middleware](<../HTTP/Middleware Explanation.md>) that build them are held end to end by the integration tests.
