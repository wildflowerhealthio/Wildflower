# Owner Resource Routes

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/list_all.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/get_by_id.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/revoke_by_id.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/update_by_id.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/revoke_by_id.rs}}

These routes are the Owner's view of what they have let in, and the switches to take it back: **the standing grants** apps hold, **the apps** themselves, and **the browsers** the server has signed in. The Owner's access-management screens call them with the Owner's token.

They live under `/authorization`, behind [`require_valid_session`](<../Middleware Explanation.md#item-require_valid_session>), and are uncached. Each handler takes its capability through `Scoped<…>`, which needs **one scope per resource and permission**: `wildflower/Grant.r` and `.d`, `wildflower/Client.r` and `.u`, `wildflower/BrowserSession.r` and `.d`. A token without it gets a `403` naming the missing scope, before the handler runs. The Owner's scopes cover every one of them. The capability is the only way to the store, so the scope can't be skipped.

## `http::routes::grants`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/mod.rs self}}

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/mod.rs router}}

### `list_all`

The handler reads through the [grants reader](<../../Capabilities/Access/Grants Explanation.md>)'s [`list`](<../../Capabilities/Access/Grants Explanation.md#item-GrantsReader--list>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/list_all.rs route}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/list_all.rs handle_list_grants}}

### `get_by_id`

The handler reads through [`get`](<../../Capabilities/Access/Grants Explanation.md#item-GrantsReader--get>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/get_by_id.rs route}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/get_by_id.rs handle_get_grant}}

### `revoke_by_id`

**Revoking a grant takes back everything it let the app hold.** The [grants revoker](<../../Capabilities/Access/Grants Explanation.md>)'s [`revoke`](<../../Capabilities/Access/Grants Explanation.md#item-GrantsRevoker--revoke>) owns the cascade: the grant is deleted, the app's refresh-token families are expired, and its revocation epoch moves to now, so its live access tokens die too. It needs `wildflower/Grant.d` alone, not `wildflower/Token.d`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/revoke_by_id.rs route}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/revoke_by_id.rs handle_revoke_grant}}

The [Smoke](<../../Integration Tests/Smoke Explanation.md>), [Grant Flows](<../../Integration Tests/Grant Flows Explanation.md>), [Revocation](<../../Integration Tests/Revocation Explanation.md>), [Device Code](<../../Integration Tests/Device Code Explanation.md>) and [Scope Gating](<../../Integration Tests/Scope Gating Explanation.md>) tests hold these routes to listing, a `404` for an unknown id, the revocation cascade, and the read and delete scopes.

## `http::routes::clients`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/mod.rs self}}

### `openapi_router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/mod.rs openapi_router}}

### `list_all`

The list comes from the [clients reader](<../../Capabilities/Access/Clients Explanation.md>)'s [`list`](<../../Capabilities/Access/Clients Explanation.md#item-ClientsReader--list>), as [`ClientView`](<../../Capabilities/Access/Clients Explanation.md#item-ClientView>)s. The secret's hash never leaves the server, and the essential apps (see [`is_essential_client`](<../../Domain/Client Explanation.md#item-is_essential_client>)) are marked so the list offers no switch for them.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs ClientBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs "<ClientBody as From>::from"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs handle_list_clients}}

### `update_by_id`

**The one thing the Owner may change about an app is whether it is disabled.** Any time sent disables the app now, stamped with the server's clock, so a disable can't be scheduled or backdated. The [clients disabler](<../../Capabilities/Access/Clients Explanation.md>)'s [`set_disabled_at`](<../../Capabilities/Access/Clients Explanation.md#item-ClientsDisabler--set_disabled_at>) is what refuses an essential app.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/update_by_id.rs UpdateClientBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/update_by_id.rs handle_update_client}}

The [Client Management](<../../Integration Tests/Client Management Explanation.md>) tests hold these routes to listing without secrets, the server's own time, idempotence, refusing a body without `disabledAt`, the essential apps, a `404` for an unknown app, and a disabled app being refused at `/oauth/authorize` until it is re-enabled.

## `http::routes::browser_sessions`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/mod.rs self}}

### `router`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/mod.rs router}}

### `list_all`

**Every browser signed in right now**, newest first, each marked when it is the caller's own. The [browser sessions reader](<../../Capabilities/Access/Browser Sessions Explanation.md>)'s [`list_live`](<../../Capabilities/Access/Browser Sessions Explanation.md#item-BrowserSessionsReader--list_live>) gives the list. The caller's `sid` comes from `Authenticated<LiveSessionReader>`, which reads only the caller's own claims.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs BrowserSessionBody}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs "<BrowserSessionBody as From>::from"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs route}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs handle_list_browser_sessions}}

### `revoke_by_id`

**Revoking a browser session ends everything minted under it**: the browser's own token, and every access token and refresh family an app it signed in to holds. The caller may revoke its own session, which signs that browser out. It goes through the [browser sessions revoker](<../../Capabilities/Access/Browser Sessions Explanation.md>)'s [`revoke`](<../../Capabilities/Access/Browser Sessions Explanation.md#item-BrowserSessionsRevoker--revoke>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/revoke_by_id.rs route}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/revoke_by_id.rs handle_revoke_browser_session}}

The [Browser Sessions](<../../Integration Tests/Browser Sessions Explanation.md>) tests hold these routes to listing live sessions, revoking one, signing out the caller's own, ending an app authorized in a revoked session, and their scopes.
