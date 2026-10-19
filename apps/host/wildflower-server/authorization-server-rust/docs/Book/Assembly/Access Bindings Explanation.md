# Access Bindings

{{#covers apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs}}

The `/authorization` surface is the Owner's: grants, apps, browsers, consent prompts and tokens. **Every one of its capabilities is behind a scope**, and these bindings say which. A handler names one in `Scoped<…>`; the extractor reads the verified claims the session gate left on the request, and builds the capability only if the token covers its required scopes. Otherwise the request gets a `403` naming what is missing, and the capability never exists. Each required scope comes from the capability's own `*_scopes()` function, the same one the list of grantable admin scopes reads, so what is enforced and what can be granted can't drift.

Most bindings are **fixed-scope** (`FixedScopeCapability`): one scope set gates the whole capability, and `build` never sees the caller's grant. The consent reader and decider are **data-dependent** (`Capability`): they are gated by a scope too, but what approving a prompt takes depends on the prompt, so `build` keeps the caller's grant for the methods to check per call.

## `LiveGrantsReader`

Read the standing grants: `wildflower/Grant.r`. Built over the store. Its methods are on [Grants](<../Capabilities/Access/Grants Explanation.md>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveGrantsReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveGrantsReader::build}}

## `LiveGrantsRevoker`

Revoke a grant, with the cascade that kills its app's tokens: `wildflower/Grant.d`. Built over the store and the revocation port, which the cascade bumps the app's epoch through.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveGrantsRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveGrantsRevoker::build}}

## `LiveClientsReader`

List the registered apps: `wildflower/Client.r`. Built over the store and the essential-client guard, so each app comes back marked essential or not ([Clients](<../Capabilities/Access/Clients Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveClientsReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveClientsReader::build}}

## `LiveClientsDisabler`

Disable or re-enable an app: `wildflower/Client.u`. Built over the store and the essential-client guard, which refuses to disable an essential one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveClientsDisabler}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveClientsDisabler::build}}

## `LiveConsentReader`

Read a consent prompt, of either surface: `wildflower/AuthorizationRequest.r`. **Data-dependent**: it keeps the reader's grant, to say with each prompt which approval scopes the reader lacks ([OAuth Consents](<../Capabilities/Access/OAuth Consents Explanation.md>), [Device Consents](<../Capabilities/Access/Device Consents Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentReader::required_scopes}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentReader::build}}

## `LiveConsentRaiser`

Hand a code-flow prompt to the Owner. It takes the **read** scope, `wildflower/AuthorizationRequest.r`, as reading the prompt does: raising decides nothing. Built over the store and the [`OwnerApproval`](<Ports and Adapters Explanation.md#ownerapproval>) port, which the shared state implements, to republish the newest pending consent once the prompt is raised.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentRaiser}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentRaiser::build}}

## `LiveConsentDecider`

Approve or deny a prompt, of either surface: `wildflower/AuthorizationRequest.u`. **Data-dependent**: it keeps the approver's grant, since approving takes the prompt's approval scopes and can't delegate beyond the approver's own. Built over the store, the `OwnerApproval` port and that grant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentDecider}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentDecider::required_scopes}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveConsentDecider::build}}

## `LiveTokenRevoker`

Revoke tokens by `jti` or by subject: `wildflower/Token.d`. It touches no store, only the revocation port ([Tokens](<../Capabilities/Access/Tokens Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveTokenRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveTokenRevoker::build}}

## `LiveBrowserSessionsReader`

List the live browser sessions: `wildflower/BrowserSession.r`. Built over the store ([Browser Sessions](<../Capabilities/Access/Browser Sessions Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveBrowserSessionsReader}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveBrowserSessionsReader::build}}

## `LiveBrowserSessionsRevoker`

Revoke a browser session: `wildflower/BrowserSession.d`. Built over the store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveBrowserSessionsRevoker}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/live_bindings/access.rs LiveBrowserSessionsRevoker::build}}

No binding has a unit test of its own. The gates are held to account end to end by [Scope Gating](<../Integration Tests/Scope Gating Explanation.md>), [`under_scoped_callers_are_rejected_before_the_handler`](<../Integration Tests/Client Management Explanation.md#under_scoped_callers_are_rejected_before_the_handler>) and [`the_browsers_routes_are_scope_gated`](<../Integration Tests/Browser Sessions Explanation.md#the_browsers_routes_are_scope_gated>).
