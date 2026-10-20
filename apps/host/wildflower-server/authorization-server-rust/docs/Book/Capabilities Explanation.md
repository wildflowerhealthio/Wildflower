# Capabilities

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs}}

A **capability** is a narrow door from the HTTP layer into the [grant store](<Grant Store Explanation.md>), built for one purpose: list the grants, decide a consent prompt, redeem a code at `/oauth/token`. A handler holds a capability, never the store, so what it can do to the data is exactly what the capability offers. **The door is the gate**: whatever unlocks a capability is checked before the handler can hold one, so a handler that forgets a check has no way to reach the data at all.

Capabilities are grouped by what unlocks them:

| Group                                            | Unlocked by                                                                                                                  | Who is calling                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [Access](<Capabilities/Access Explanation.md>)   | the caller's **scopes**                                                                                                      | the Owner's UI, or a paired browser, on `/authorization`   |
| [OAuth](<Capabilities/OAuth Explanation.md>)     | the **client**, through the [authenticated client](<Authority/Authenticated Client Explanation.md>) proof, or nothing at all | an app, a device, or a browser on its way through `/oauth` |
| [Session](<Capabilities/Session Explanation.md>) | the caller's **own credential**: a verified token, or the browser's own cookie                                               | anyone signed in, acting on themselves                     |
| [Writers](<Writers Explanation.md>)              | an **authority proof**                                                                                                       | the other capabilities, inside their own store scope       |

The writers have their own part, before this one, because every other capability composes them rather than calling the store's privileged writes directly.

## The one shape

Every public method of a capability opens one store scope at its top, runs the flow inside it to an outcome, and acts on the outcome once the scope has closed. An operation that only reads opens a read scope; one that writes opens a write scope. The proofs and writers beneath take the scope's transaction, never the store, so **everything one operation writes lands together or not at all**. What can't sit inside the scope runs after it: republishing the [Owner prompt](<Domain/Owner Prompt Explanation.md>) to the host, writing to the revocation store.

An error rolls the scope back. So **a refusal that must keep what it wrote is an outcome, not an error**: a spent code, a stamped poll, a request denied for a reason the app is told. The scope commits it, and the caller reads the outcome. The consent approval shows the pattern plainly: an approval that grants nothing ends as a committed [`ConsentOutcome::Denied`](<Capabilities/Access/Consents Explanation.md#item-ConsentOutcome>), while an approver short of a scope gets an error and nothing is written.

Every capability is generic over the `GrantStore` port and holds the handles it needs, lifted from the router state when it is built, never the state itself, which keeps its logic unit-testable against the in-memory [test fake](<Grant Store/Test Fake Explanation.md>). The bindings that name the SQLite store and build each capability from the state are in the [Assembly](<Assembly Explanation.md>) part, so nothing here depends on an adapter or on HTTP.

The helpers the unit tests in this part share are on the [Test Fixtures](<Capabilities/Test Fixtures Explanation.md>) page.

## `domain::capabilities`

### `source_guards`

Two tests make "the capability is the only door" structural. They read the source of the route handlers and the authentication middleware, with comments, string literals and test code blanked out by the [source guard helpers](<Domain/Source Guards Explanation.md>), and fail if a file reaches past a capability. The token verifier they name is on the [Token Verifier](<Capabilities/Session/Token Verifier Explanation.md>) page.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::handlers_reach_the_state_only_through_capabilities}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/mod.rs source_guards::middleware_verifies_only_through_the_token_verifier}}

## In this part

- [Access](<Capabilities/Access Explanation.md>): the scope-gated `/authorization` surface the Owner's UI drives: consent prompts, grants, clients, browser sessions, token revocation.
- [OAuth](<Capabilities/OAuth Explanation.md>): the `/oauth` front door: starting an authorization, pairing a browser, signing the Owner in, the device flow, the token endpoint, the JWKS.
- [Session](<Capabilities/Session Explanation.md>): verifying a token, and what a caller may do with its own credential: read it back, log out, sign out.
- [Test Fixtures](<Capabilities/Test Fixtures Explanation.md>): the helpers the part's unit tests share.
