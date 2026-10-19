# The Authorization Server

This part is a guided read of `authorization-server-rust`, the server that decides who may use the Owner's FHIR server. This page is the map: who the actors are, what they ask for, what a yes leaves behind, and how the code is layered.

## What this server is for

One person, the **Owner**, runs a FHIR server on their own devices. Apps, browsers and devices ask for access to it. This server decides who gets in, with what, and for how long. It never decides alone: every access traces back to a moment when the Owner said yes, either just now or earlier, in a way that still stands.

Everything else in the crate serves that sentence.

## The cast

| Who                   | What they are                                                                                                                                                            | Where they live in code                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| The **Owner**         | The person whose data this is. Signs in on their own device with a same-device sign-in code, and decides every request.                                                  | `domain::capabilities::oauth::same_device_sign_in`         |
| A **client**          | An app (a SMART-on-FHIR app, a Pebble companion, the host app). It has a `client_id`, maybe a secret, and a registration that is server-defined or trusted on first use. | [Client](<Domain/Client Explanation.md>)                   |
| A **browser session** | A browser the server has let in, keyed by its `sid`. Everything minted while using that browser records the `sid`, so revoking the browser revokes what it earned.       | [Browser Session](<Domain/Browser Session Explanation.md>) |
| A **device**          | Something without a good browser (a TV, a watch) that shows a code for the Owner to type in elsewhere.                                                                   | `domain::capabilities::oauth::device_authorizer`           |

## Three ways to ask

Every request for access becomes one row: an [**`AuthorizationRequest`**](<Domain/Authorization Request Explanation.md>). It comes in three kinds, and they share one lifecycle.

| Kind                   | Who asks                              | What a yes produces                      | Standard             |
| ---------------------- | ------------------------------------- | ---------------------------------------- | -------------------- |
| **Authorization code** | An app, running in a paired browser   | A one-minute code, then tokens           | RFC 6749 §4.1 + PKCE |
| **Device code**        | A device showing a user code          | Tokens, collected by the device's poll   | RFC 8628             |
| **Browser pairing**    | A browser wanting to become a session | A browser session, collected by its poll | Ours, not OAuth      |

The order matters. A browser **pairs first** and then makes app requests, because an app's code is always issued under the browser session it was requested in.

## What a yes leaves behind

| Thing                                                                | Lifetime                                                                    | Why it exists                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [**Grant**](<Domain/Grant Explanation.md>)                           | Until revoked                                                               | "The Owner already said yes to this app at this redirect." Lets the next request skip asking.   |
| [**Authorization code**](<Domain/Authorization Code Explanation.md>) | 60 seconds, single use                                                      | Carries the approval from the browser to the app's back end without putting a token in a URL.   |
| [**Refresh family**](<Domain/Refresh Token Explanation.md>)          | 90 days from the authorization; rotation never extends it                   | One chain of refresh tokens from one authorization. Replaying an old link ends the whole chain. |
| [**Browser session**](<Domain/Browser Session Explanation.md>)       | Eight hours for the Owner's, a day for a paired browser's, or until revoked | The browser's standing permission. It caps what any app requested in that browser can receive.  |

## How the code is layered

A request moves through the layers from the top down.

```text
http/routes/…           axum handlers: parse, call ONE capability, render
  └─ domain/capabilities/…   one operation = one store scope (read or write)
       ├─ domain/<entity>.rs      the rules: AuthorizationRequest, BrowserSession, …
       ├─ domain/authority/…      proofs: "on whose authority is this written?"
       └─ domain/capabilities/writers/…  the ONLY place privileged writes happen
            └─ domain/grant_store/…      the port: GrantStore opens a scope, GrantTx does one statement
                 └─ db/…                 the SQL behind each GrantTx method
```

Hold on to three rules while you read. Most of the code exists to enforce one of them.

1. **One operation, one scope.** A capability opens a single read or write scope at its top, runs the whole flow inside it, and does side effects (notifying the Owner, signing a token) only after the scope closes.
2. **Every privileged write takes a proof.** You can't call "issue a code" without passing a value that only the rule-checking function can construct. Auditing who can grant access means reading two short lists: the proofs in `domain/authority/` and the writers in `capabilities/writers/`.
3. **A request changes only through its own transitions**, and a transition lands only if the row hasn't moved since it was read. The [Authorization Request](<Domain/Authorization Request Explanation.md>) page ends with the guarded replace that makes it so.

## How this part is organised

The rest of the part reads the code twice, from opposite ends.

**[Domain](<Domain Explanation.md>)** goes bottom up. Each entity in `src/domain/` gets a page: what it is and why it exists, its types, and then a section per method saying what the method means for the Owner, the app or the person at the browser, with the method and the unit tests that exercise it. The pages are ordered so that each one needs only the ones before it.

**[Integration Tests](<Integration Tests Explanation.md>)** goes top down. Each file in `tests/integration/` gets a page, and each test a section: the promise the test holds the server to, the test itself, and links back to the domain sections the promise rests on. The first page, [Grant Flows](<Integration Tests/Grant Flows Explanation.md>), follows one app's request from the front door to its token.
