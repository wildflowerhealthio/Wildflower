# The Authorization Server

This part is a guided read of `authorization-server-rust`, the server that decides who may use the Owner's FHIR server. This page is the map: who the actors are, what they ask for, what a yes leaves behind, and how the code is layered.

## What this server is for

One person, the **Owner**, runs a FHIR server on their own devices. Apps, browsers and devices ask for access to it. This server decides who gets in, with what, and for how long. It never decides alone: every access traces back to a moment when the Owner said yes, either just now or earlier, in a way that still stands.

Everything else in the crate serves that sentence.

## The cast

| Who                   | What they are                                                                                                                                                            | Where they are explained                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| The **Owner**         | The person whose data this is. Signs in on their own device with a same-device sign-in code, and decides every request.                                                  | [Same-Device Sign-In Codes](<Domain/Same Device Sign In Codes Explanation.md>)   |
| A **client**          | An app (a SMART-on-FHIR app, a Pebble companion, the host app). It has a `client_id`, maybe a secret, and a registration that is server-defined or trusted on first use. | [Client](<Domain/Client Explanation.md>)                                         |
| A **browser session** | A browser the server has let in, keyed by its `sid`. Everything minted while using that browser records the `sid`, so revoking the browser revokes what it earned.       | [Browser Session](<Domain/Browser Session Explanation.md>)                       |
| A **device**          | Something without a good browser (a TV, a watch) that shows a code for the Owner to type in elsewhere.                                                                   | [Polled Requests](<Domain/Authorization Request/Polled Requests Explanation.md>) |

## Three ways to ask

Every request for access is an [**authorization request**](<Domain/Authorization Request Explanation.md>), parked until the Owner decides it. There are three flows, each its own type with its own states.

| Flow                   | Who asks                               | What a yes produces                      | Standard             |
| ---------------------- | -------------------------------------- | ---------------------------------------- | -------------------- |
| **Authorization code** | An app, running in a signed-in browser | A one-minute code, then tokens           | RFC 6749 §4.1 + PKCE |
| **Device code**        | A device showing a user code           | Tokens, collected by the device's poll   | RFC 8628             |
| **Browser pairing**    | A browser wanting to become a session  | A browser session, collected by its poll | Ours, not OAuth      |

The order matters. A browser **signs in or pairs first** and then makes app requests, because an app's code is always issued under the browser session it was requested in.

## What a yes leaves behind

| Thing                                                                | Lifetime                                                                        | Why it exists                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [**Grant**](<Domain/Grant Explanation.md>)                           | Until revoked                                                                   | "The Owner already said yes to this app at this redirect." Lets a later request skip asking.    |
| [**Authorization code**](<Domain/Authorization Code Explanation.md>) | 60 seconds, single use                                                          | Carries the approval from the browser to the app's back end without putting a token in a URL.   |
| [**Access token**](<Domain/Access Token Explanation.md>)             | 15 minutes                                                                      | What the app shows the FHIR server. Signed, so anything holding the public key can check it.    |
| [**Refresh family**](<Domain/Refresh Token Explanation.md>)          | 90 days from the authorization; rotation never extends it                       | One chain of refresh tokens from one authorization. Replaying an old link ends the whole chain. |
| [**Browser session**](<Domain/Browser Session Explanation.md>)       | Eight hours for a same-device session, a day for a paired one, or until revoked | The browser's standing permission. It caps what any app requested in that browser can receive.  |

## How the code is layered

A request moves through the layers from the top down.

```text
http/routes/…           axum handlers: parse, call ONE capability, render
  └─ domain/capabilities/…   one operation = one store scope (read or write)
       ├─ domain/<entity>         the rules: CodeRequest, BrowserSession, Grant, …
       ├─ domain/authority/…      proofs: "on whose authority is this written?"
       └─ domain/capabilities/writers/…  the ONLY place privileged writes happen
            └─ domain/grant_store/…      the port: GrantStore opens a scope, GrantTx does one statement
                 └─ db/…                 the SQL behind each GrantTx method
```

Hold on to three rules while you read. Most of the code exists to enforce one of them.

1. **One operation, one scope.** A capability opens a single read or write scope at its top, runs the whole flow inside it, and does side effects (notifying the Owner, the revocation store) only after the scope closes.
2. **Every privileged write takes a proof.** You can't call "issue a code" without passing a value that only the rule-checking function can construct. Auditing who can grant access means reading two short lists: the proofs in `domain/authority/` and the writers in `capabilities/writers/`.
3. **A request changes only through its own transitions**, and a transition lands only while the row still has the status it was read with. The [Authorization Request](<Domain/Authorization Request Explanation.md>) page shows the guarded replace that makes it so.

## How this part is organised

The rest of the part reads the code twice, from opposite ends.

The first pass goes bottom up, one layer per chapter, each needing only the ones before it. A page takes one or a few source files, and its headings follow the code: a module, then its types and free functions, then each type's methods. Each item shows its doc comment, its source, and right under it the unit tests that hold it, each captioned by the promise it keeps. The page's own prose says what crosses items: the domain story, why things are as they are, and how the pieces relate. The helpers the tests share are on a Test Fixtures page at the end of the chapter.

1. **[Domain](<Domain Explanation.md>)**: the entities and the rules they own.
2. **[Grant Store](<Grant Store Explanation.md>)**: what persistence looks like from the domain, one scope per operation.
3. **[Authority](<Authority Explanation.md>)**: the proofs every privileged write demands.
4. **[Writers](<Writers Explanation.md>)**: the only places those writes happen.
5. **[Capabilities](<Capabilities Explanation.md>)**: the operations, split by what unlocks them.
6. **[HTTP](<HTTP Explanation.md>)**: the gates, the extractors and every route.
7. **[Assembly](<Assembly Explanation.md>)**: how the crate is put together and handed to the host.
8. **[Persistence](<Persistence Explanation.md>)**: the SQLite behind the Grant Store.
9. **[Utilities](<Utilities Explanation.md>)**: the small cryptographic helpers.

The second pass, **[Integration Tests](<Integration Tests Explanation.md>)**, goes top down. Each file in `tests/integration/` gets a page, and each test a section: the promise the test holds the server to, the test itself, and links back to the sections the promise rests on. The first page, [Grant Flows](<Integration Tests/Grant Flows Explanation.md>), follows one app's request from the front door to its token.
