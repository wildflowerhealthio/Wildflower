# Session

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/mod.rs}}

The session capabilities are what a caller does with **its own** credential: checking it, reading it back, ending it. Every other capability acts on a request, a grant or a client the caller names; these act only on the token or the [browser session](<../Domain/Browser Session Explanation.md>) the caller already holds. That is why none of them takes a scope. The Owner, an app and a browser with the narrowest pairing can all log out and read what they hold, and a scope gate here would lock out exactly the under-scoped callers who need to.

The first of them is how the server learns what a caller holds at all. **Every [access token](<../Domain/Access Token Explanation.md>) the server accepts passes through the [token verifier](<Session/Token Verifier Explanation.md>)**: the `/authorization` bearer gate, the bearer gate the host layers over its FHIR and other routes, the browser-session cookie checks, and the FHIR server's own check, in process. The rest of the part builds on its answer.

The capabilities reach a handler two ways. Those that act on the bearer the gate verified, the [session ender](<Session/Session Ender Explanation.md>) and the [session reader](<Session/Session Reader Explanation.md>), come through the shared `Authenticated<…>` extractor, which builds them from the verified claims and checks no scope. Those that act on a browser's cookie rather than a bearer, the [browser session ender](<Session/Browser Session Ender Explanation.md>) and the [browser session use recorder](<Session/Browser Session Use Recorder Explanation.md>), and the verifier itself, are built from the state alone; their callers verify the cookie's token first. The [Session Bindings](<../Assembly/Session Bindings Explanation.md>) page shows each one's construction.

## In this part

- [Token Verifier](<Session/Token Verifier Explanation.md>): the one access-token check, signature to revocation, that every gate runs.
- [Session Reader](<Session/Session Reader Explanation.md>): a caller reading back its own scopes and its browser session's expiry.
- [Session Ender](<Session/Session Ender Explanation.md>): logout, denylisting the presented token.
- [Browser Session Ender](<Session/Browser Session Ender Explanation.md>): sign-out, revoking the browser session the cookie holds.
- [Browser Session Use Recorder](<Session/Browser Session Use Recorder Explanation.md>): moving a browser session's `last_seen_at` when its cookie is accepted.
