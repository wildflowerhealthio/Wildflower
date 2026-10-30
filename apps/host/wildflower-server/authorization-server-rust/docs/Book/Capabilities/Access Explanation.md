# Access

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs}}

The `/authorization` surface is where the server is administered: the Owner's UI decides a consent prompt, lists the standing grants and revokes one, disables an app, signs a browser out, revokes a token. A paired browser reaches the same surface, holding less. **What a caller may do here is exactly what its token's scopes cover.** The scopes are Wildflower resource scopes (`wildflower/Grant.r` to read the grants, `wildflower/Grant.d` to revoke one), and the Owner's token carries `wildflower/*.cruds`, which [covers](<../Domain/Scopes Explanation.md#item-allowed_scope_covers>) every one of them.

## The `Scoped<…>` extractor

A handler on this surface takes its capability as `Scoped<…>`, never the store. The extractor reads the [verified claims](<../Domain/Access Token Explanation.md#item-VerifiedClaims>) the bearer gate left on the request, checks that they cover every scope the capability requires, and **only then builds the capability**. A token short of a scope gets a `403` naming the scopes it lacks, and the handler never runs.

{{#code slices/scopes/scope-capabilities-rust/src/lib.rs Scoped::from_request_parts from="let required_scopes" through="if missing.is_empty()"}}

The extractor and its traits are shared with other slices, in the scope-capabilities crate. A capability comes in one of two flavours:

- **Fixed-scope**: one static scope set gates the whole capability. Most capabilities here are this flavour.
- **Data-dependent**: the static gate admits the caller, and the capability keeps the caller's own grant to check more on each call. The consent reader and decider are this flavour, since approving a request takes scopes that depend on the request ([the approval scopes](<Access/Consents Explanation.md>)).

Each capability's file declares its gate as a `*_scopes()` function, which the capability's binding enforces:

| Capability                                                                                       | Route                                                                             | Gate                                                                   |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`ConsentReader`](<Access/Consents Explanation.md#item-ConsentReader>)                           | `GET /authorization/oauth-consents/{id}`, `GET /authorization/devices/{userCode}` | `wildflower/AuthorizationRequest.r`, plus the caller's grant           |
| [`ConsentRaiser`](<Access/Consents Explanation.md#item-ConsentRaiser>)                           | `POST /authorization/oauth-consents/{id}/ask-owner`                               | `wildflower/AuthorizationRequest.r`                                    |
| [`ConsentDecider`](<Access/Consents Explanation.md#item-ConsentDecider>)                         | `POST …/approve` and `POST …/deny` on both consent routes                         | `wildflower/AuthorizationRequest.u`, plus the approval scopes per call |
| [`GrantsReader`](<Access/Grants Explanation.md#item-GrantsReader>)                               | `GET /authorization/grants`, `GET /authorization/grants/{id}`                     | `wildflower/Grant.r`                                                   |
| [`GrantsRevoker`](<Access/Grants Explanation.md#item-GrantsRevoker>)                             | `DELETE /authorization/grants/{id}`                                               | `wildflower/Grant.d`                                                   |
| [`ClientsReader`](<Access/Clients Explanation.md#item-ClientsReader>)                            | `GET /authorization/clients`                                                      | `wildflower/Client.r`                                                  |
| [`ClientsUpdater`](<Access/Clients Explanation.md#item-ClientsUpdater>)                          | `PATCH /authorization/clients/{clientId}`                                         | `wildflower/Client.u`                                                  |
| [`BrowserSessionsReader`](<Access/Browser Sessions Explanation.md#item-BrowserSessionsReader>)   | `GET /authorization/browser-sessions`                                             | `wildflower/BrowserSession.r`                                          |
| [`BrowserSessionsRevoker`](<Access/Browser Sessions Explanation.md#item-BrowserSessionsRevoker>) | `DELETE /authorization/browser-sessions/{sid}`                                    | `wildflower/BrowserSession.d`                                          |
| [`TokenRevoker`](<Access/Tokens Explanation.md#item-TokenRevoker>)                               | `POST /authorization/revocations`                                                 | `wildflower/Token.d`                                                   |

## `domain::capabilities::access`

### `grantable_admin_scopes`

**Each scope this surface checks is spelt in exactly one place**, its `*_scopes()` function, and this list reads every one of them, so what a token can be given and what it is checked against can't drift apart. A misspelt scope would parse as an unknown scope that the Owner's `wildflower/*.cruds` can't cover, locking the Owner out of that route; the second test rules that out.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs grantable_admin_scopes tests="tests::grantable_admin_scopes_are_the_expected_wildflower_scopes tests::every_required_scope_is_a_known_wildflower_resource_not_unknown tests::every_capability_scope_fn_is_registered_in_the_grantable_vocabulary"}}

## In this part

- [Consents](<Access/Consents Explanation.md>): the consent capabilities, their approval scopes, and what the prompt pages read and send.
- [OAuth Consents](<Access/OAuth Consents Explanation.md>): reading, raising, approving and denying an app's request for a code.
- [Device Consents](<Access/Device Consents Explanation.md>): the device page's prompt, a device request or a browser pairing.
- [Grants](<Access/Grants Explanation.md>): listing the standing grants, and revoking one with everything issued under it.
- [Clients](<Access/Clients Explanation.md>): the trusted-apps list, and disabling or re-enabling an app.
- [Browser Sessions](<Access/Browser Sessions Explanation.md>): the signed-in browsers, and signing one out.
- [Tokens](<Access/Tokens Explanation.md>): revoking a token by its `jti`, or every token of a subject.
