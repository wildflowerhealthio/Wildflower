# Capabilities

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs}}

A **capability** is a narrow door from the HTTP layer into the grant store, built for one purpose: list the grants, decide a consent prompt, redeem a code at `/token`. A handler holds a capability, never the store, so what it can do to the data is exactly what the capability offers. **The door is the gate**: whatever unlocks a capability is checked before the handler can hold one, so a handler that forgets a check has no way to reach the data at all.

Capabilities are grouped by **what unlocks them**:

| Group                                            | Unlocked by                                                                 | Who is calling                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| [Access](<Capabilities/Access Explanation.md>)   | the caller's **scopes**, checked by the `Scoped<…>` extractor               | the Owner's UI, or an approved browser, on `/authorization` |
| [OAuth](<Capabilities/OAuth Explanation.md>)     | the **client**: an `AuthenticatedClient` proof, or nothing at all           | an app, or a browser on its way through `/oauth`            |
| [Session](<Capabilities/Session Explanation.md>) | the caller's **own session**: a verified token, or the browser's own cookie | anyone signed in, acting on themselves                      |
| [Writers](<Writers Explanation.md>)              | an **authority proof**                                                      | the other capabilities, inside their own scope              |

The writers are the privileged writes themselves: approve a request, issue a code, record a grant, mint a token. They have their own part, before this one, because every other capability composes them rather than calling the store's privileged primitives directly.

## The one shape

**Every public method of a capability opens one store scope at its top, runs the flow inside it to an outcome value, and acts on the outcome once the scope has closed.** An operation that only reads opens a read scope; one that writes opens a write scope. The flows, proofs and writers beneath take the scope's transaction, never the store, so everything one operation writes lands together or not at all.

What happens after the scope closes is what can't sit inside it: republishing the newest pending consent to the host, signing a token, writing to the revocation store.

An error rolls the scope back. So **a refusal that must keep what it wrote is an outcome, not an error**: a spent code, a stamped poll, a request denied for a reason the app is told. The scope commits it, and the caller reads the outcome. The consent approvals show the pattern plainly: [`ConsentOutcome::Denied`](<Capabilities/Access/Consents Explanation.md#consentoutcome>) is a committed deny, while an approver short of a scope gets an error and nothing is written.

Every capability is generic over the [`GrantStore`](<Grant Store Explanation.md>) port and holds the dependencies it needs, lifted from the router state when it is built. It never holds the state itself, which keeps its logic unit-testable against the in-memory fake. The bindings that name the concrete SQLite store and build each capability from the state are in the Assembly part ([Access Bindings](<Assembly/Access Bindings Explanation.md>), [OAuth Bindings](<Assembly/OAuth Bindings Explanation.md>), [Session Bindings](<Assembly/Session Bindings Explanation.md>)), so nothing here depends on an adapter or on the HTTP layer.

## Source guards

Two tests make "the capability is the only door" structural. They read the source of the handler and middleware files and fail if one reaches past a capability. They are advisory-strength, since the needles are textual. Comments, string literals and `#[cfg(test)]` items are blanked out first, by the shared helpers on the [Source Guards](<Domain/Source Guards Explanation.md>) page.

## `handlers_reach_the_state_only_through_capabilities`

**A route handler reaches the server's state only through a capability extractor**: `Scoped<…>` (scope-gated), `Authenticated<…>` (the caller's own session) or `Live<…>` (the front door, whose gate is the proof its methods take). A handler naming the raw router state, or any field of it that leads to data or a side channel (the store, the revocation store, the Owner-approval channel, the sign-in codes), fails the test with its file and line.

The routes folder is walked at test time, so a new handler file is guarded without being added to a list. Only `mod.rs` glue is exempt. The closing count check catches the folder moving, which would otherwise leave the test passing while checking nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::handlers_reach_the_state_only_through_capabilities}}

## `middleware_verifies_only_through_the_token_verifier`

**The authentication gates verify a token only through the token verifier capability**, so the verification policy (signature, issuer and audience, revocation) has one home. A middleware file naming the store or the revocation store fails the test.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::middleware_verifies_only_through_the_token_verifier}}

The policy itself is on the [Token Verifier](<Capabilities/Session/Token Verifier Explanation.md>) page.

## In this part

- [Access](<Capabilities/Access Explanation.md>): the scope-gated `/authorization` surface the Owner's UI drives: grants, clients, consent prompts, token revocation, browser sessions.
- [OAuth](<Capabilities/OAuth Explanation.md>): the `/oauth` front door: starting an authorization, pairing a browser, the device flow, the token endpoint, the JWKS.
- [Session](<Capabilities/Session Explanation.md>): verifying a token, and what a caller may do with its own session: read it back, log out, sign out.
