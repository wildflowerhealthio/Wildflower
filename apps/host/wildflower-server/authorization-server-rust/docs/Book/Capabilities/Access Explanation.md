# Access

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs}}

The `/authorization` surface is where the server is administered: the Owner's UI lists the standing grants and revokes one, disables an app, decides a consent prompt, revokes a token or a signed-in browser. An approved browser reaches the same surface, holding less. **What a caller may do here is exactly what its token's scopes cover**, and the scopes are Wildflower resource scopes: `wildflower/Grant.r` to read the grants, `wildflower/Grant.d` to revoke one, and so on. The Owner's token carries `wildflower/*.cruds`, which covers every one of them.

## The `Scoped<…>` extractor

A handler on this surface takes its capability as `Scoped<LiveGrantsReader>`, never the store. The extractor reads the verified claims the bearer gate left on the request, checks that they cover every scope the capability requires, and **only then builds the capability**. A token short of a scope gets a `403` naming the scopes it lacks, and the handler never runs.

{{#code slices/scopes/scope-capabilities-rust/src/lib.rs Scoped::from_request_parts from="let required_scopes" through="if missing.is_empty()"}}

The extractor and its traits are shared with other slices, in the scope-capabilities crate. A capability comes in one of two flavours, visible at its `impl` line in the [Access Bindings](<../Assembly/Access Bindings Explanation.md>):

- **Fixed-scope** (`FixedScopeCapability`): one static scope set gates the whole capability. Most capabilities here are this flavour. An empty set is refused at request time with a `500`, since it would look gated while gating nothing.
- **Data-dependent** (`Capability` implemented directly): the static gate admits the caller, and the capability keeps the caller's own grant to check more per call. The consent reader and decider are this flavour: approving a request takes scopes that depend on the request ([the approval scopes](<Access/Consents Explanation.md>)).

| Capability                                                                                  | Route                                                                             | Gate                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`GrantsReader`](<Access/Grants Explanation.md#grantsreader>)                               | `GET /authorization/grants`, `GET /authorization/grants/{id}`                     | `wildflower/Grant.r`                                                   |
| [`GrantsRevoker`](<Access/Grants Explanation.md#grantsrevoker>)                             | `DELETE /authorization/grants/{id}`                                               | `wildflower/Grant.d`                                                   |
| [`ClientsReader`](<Access/Clients Explanation.md#clientsreader>)                            | `GET /authorization/clients`                                                      | `wildflower/Client.r`                                                  |
| [`ClientsDisabler`](<Access/Clients Explanation.md#clientsdisabler>)                        | `PATCH /authorization/clients/{clientId}`                                         | `wildflower/Client.u`                                                  |
| [`ConsentReader`](<Access/Consents Explanation.md#consentreader>)                           | `GET /authorization/oauth-consents/{id}`, `GET /authorization/devices/{userCode}` | `wildflower/AuthorizationRequest.r`, plus the caller's grant           |
| [`ConsentRaiser`](<Access/Consents Explanation.md#consentraiser>)                           | `POST /authorization/oauth-consents/{id}/ask-owner`                               | `wildflower/AuthorizationRequest.r`                                    |
| [`ConsentDecider`](<Access/Consents Explanation.md#consentdecider>)                         | `POST …/approve` and `POST …/deny` on both consent routes                         | `wildflower/AuthorizationRequest.u`, plus the approval scopes per call |
| [`TokenRevoker`](<Access/Tokens Explanation.md#tokenrevoker>)                               | `POST /authorization/revocations`                                                 | `wildflower/Token.d`                                                   |
| [`BrowserSessionsReader`](<Access/Browser Sessions Explanation.md#browsersessionsreader>)   | `GET /authorization/browser-sessions`                                             | `wildflower/BrowserSession.r`                                          |
| [`BrowserSessionsRevoker`](<Access/Browser Sessions Explanation.md#browsersessionsrevoker>) | `DELETE /authorization/browser-sessions/{sid}`                                    | `wildflower/BrowserSession.d`                                          |

Exercised end to end by the [Scope Gating](<../Integration Tests/Scope Gating Explanation.md>) tests, and by [`under_scoped_callers_are_rejected_before_the_handler`](<../Integration Tests/Client Management Explanation.md#under_scoped_callers_are_rejected_before_the_handler>) and [`the_browsers_routes_are_scope_gated`](<../Integration Tests/Browser Sessions Explanation.md#the_browsers_routes_are_scope_gated>).

## `grantable_admin_scopes`

**Each scope this surface checks is spelt in exactly one place**: a `*_scopes()` function beside its capability. The capability's binding reads it to enforce the gate, and this function reads every one of them to list what can be granted, so what a token can be given and what it is checked against can't drift apart. The approval scopes the consent decider checks per call are listed too. The list is deduplicated, in declaration order.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs grantable_admin_scopes}}

It is exported from the crate as the vocabulary for consent surfaces to offer; nothing outside its tests calls it.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs tests::grantable_admin_scopes_are_the_expected_wildflower_scopes}}

The eleven scopes, rendered, in the order the capabilities declare them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs tests::every_required_scope_is_a_known_wildflower_resource_not_unknown}}

Every scope parses as a Wildflower resource scope. A misspelt one would parse as an unknown scope, which the Owner's `wildflower/*.cruds` can't cover, locking the Owner out of that route.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/mod.rs tests::every_capability_scope_fn_is_registered_in_the_grantable_vocabulary}}

The count of `*_scopes()` functions in the capability files matches the eleven entries the function declares, so a new checked scope that isn't added to the list fails here.

## In this part

- [Consents](<Access/Consents Explanation.md>): the consent capabilities, their approval scopes, and what the prompt pages read and send.
- [OAuth Consents](<Access/OAuth Consents Explanation.md>): reading, raising, approving and denying an authorization-code prompt.
- [Device Consents](<Access/Device Consents Explanation.md>): the device page's prompt, a device request or a browser pairing.
- [Grants](<Access/Grants Explanation.md>): listing the standing grants, and revoking one with everything issued under it.
- [Clients](<Access/Clients Explanation.md>): the trusted-apps list, and disabling or re-enabling an app.
- [Browser Sessions](<Access/Browser Sessions Explanation.md>): the signed-in browsers, and signing one out.
- [Tokens](<Access/Tokens Explanation.md>): revoking a token by its `jti`, or every token of a subject.
