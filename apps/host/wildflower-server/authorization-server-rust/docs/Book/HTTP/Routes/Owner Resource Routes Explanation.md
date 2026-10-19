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

These are the Owner's view of what they have let in, and the switches to take it back: **the standing grants** apps hold, **the apps** themselves, and **the browsers** the server has signed in. The Owner's access-management screens call them with the Owner's token.

They live under `/authorization`, behind {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/middleware/require_auth.rs require_valid_session}} (a `401` without a valid, unrevoked bearer token) and uncached. Each handler acquires its capability through `Scoped<…>`, which needs **one scope per resource and permission**: `wildflower/Grant.r` and `.d`, `wildflower/Client.r` and `.u`, `wildflower/BrowserSession.r` and `.d`. A token without it gets a `403` naming the missing scope, before the handler runs. The Owner's scopes cover every one of them.

## `grants::router`

`GET /authorization/grants` lists, and `/authorization/grants/{id}` answers both `GET` and `DELETE`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/mod.rs router}}

## `handle_list_grants`

`GET /authorization/grants`. **Every standing grant, of both kinds**, in the order they were granted: what each app or device has been allowed and keeps. Through `Scoped<LiveGrantsReader>` ([`list`](<../../Capabilities/Access/Grants Explanation.md#list>)), so the read scope can't be skipped: the capability is the only way to the store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/list_all.rs handle_list_grants}}

Exercised end to end by [`access_grants_with_owner_token_returns_empty_list`](<../../Integration Tests/Smoke Explanation.md#access_grants_with_owner_token_returns_empty_list>), [`consent_approval_persists_grant`](<../../Integration Tests/Grant Flows Explanation.md#consent_approval_persists_grant>) and [`access_grants_list_with_grant_read_scope_returns_200`](<../../Integration Tests/Scope Gating Explanation.md#access_grants_list_with_grant_read_scope_returns_200>).

## `handle_get_grant`

`GET /authorization/grants/{id}`. One grant, or `404` when no grant has the id. Through `Scoped<LiveGrantsReader>` ([`get`](<../../Capabilities/Access/Grants Explanation.md#get>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/get_by_id.rs handle_get_grant}}

Exercised end to end by [`get_unknown_grant_returns_404`](<../../Integration Tests/Smoke Explanation.md#get_unknown_grant_returns_404>).

## `handle_revoke_grant`

`DELETE /authorization/grants/{id}`. **Revoking a grant takes back everything it let the app hold.** The grant is deleted, the refresh-token families minted under its app are expired, and the app's revocation epoch moves to now, so its live access tokens die too. No app that asked for `offline_access`, and no leaked bearer, outlives the revocation. Through `Scoped<LiveGrantsRevoker>` ([`revoke`](<../../Capabilities/Access/Grants Explanation.md#revoke>)), which owns that cascade; it needs `wildflower/Grant.d` alone, not `wildflower/Token.d`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/grants/revoke_by_id.rs handle_revoke_grant}}

The answer is `204 No Content`, or `404` when no grant has the id.

Exercised end to end by [`revoking_a_grant_bumps_the_client_revocation_epoch`](<../../Integration Tests/Revocation Explanation.md#revoking_a_grant_bumps_the_client_revocation_epoch>), [`revoking_a_device_grant_bumps_the_client_revocation_epoch`](<../../Integration Tests/Revocation Explanation.md#revoking_a_device_grant_bumps_the_client_revocation_epoch>), [`revoking_grant_revokes_refresh_tokens`](<../../Integration Tests/Device Code Explanation.md#revoking_grant_revokes_refresh_tokens>) and [`access_grants_delete_with_only_read_scope_returns_403_missing_delete`](<../../Integration Tests/Scope Gating Explanation.md#access_grants_delete_with_only_read_scope_returns_403_missing_delete>).

## `openapi_router`

The app routes are the one documented part of `/authorization`: they are built as an `OpenApiRouter`, so the committed OpenAPI snapshot covers them, and the TypeScript client is checked against it. [`router`](<../../HTTP Explanation.md>) splits it, serving the routes under `/authorization` behind the session gate and putting their spec in the documented surface.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/mod.rs openapi_router}}

## `ClientBody`

**An app as the Owner's list shows it**: its row's columns but two, and whether it is **essential**. The secret's hash never leaves the server, and the registration source isn't shown. The essential apps are the host app's and the browser-session client; disabling either is refused, so the list offers no switch for them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs ClientBody}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs ClientBody::from}}

## `handle_list_clients`

`GET /authorization/clients`. **Every registered app**, seeded or trusted on first use, disabled ones included, ordered by `clientId`. Through `Scoped<LiveClientsReader>` ([`list`](<../../Capabilities/Access/Clients Explanation.md#list>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/list_all.rs handle_list_clients}}

Exercised end to end by [`list_shows_seeded_and_trusted_on_first_use_clients_without_secrets`](<../../Integration Tests/Client Management Explanation.md#list_shows_seeded_and_trusted_on_first_use_clients_without_secrets>) and [`under_scoped_callers_are_rejected_before_the_handler`](<../../Integration Tests/Client Management Explanation.md#under_scoped_callers_are_rejected_before_the_handler>).

## `UpdateClientBody`

The one thing the Owner may change about an app: **whether it is disabled**. `disabledAt` must be present; `null` re-enables. Any time sent disables the app now, stamped with the server's clock, so a disable can't be scheduled or backdated. An unknown field, or a body without `disabledAt`, fails to parse, so an empty body can't re-enable an app by omission.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/update_by_id.rs UpdateClientBody}}

## `handle_update_client`

`PATCH /authorization/clients/{clientId}`. **The Owner disables an app, or turns it back on.** A disabled app gets nothing at `/oauth/authorize` or `/oauth/token`. Through `Scoped<LiveClientsDisabler>` ([`set_disabled_at`](<../../Capabilities/Access/Clients Explanation.md#set_disabled_at>)). The handler throws the sent time away and passes its own now.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/clients/update_by_id.rs handle_update_client}}

| Answer | When                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | The app as stored. Disabling an app already disabled keeps its first `disabledAt`; re-enabling one already enabled is a no-op. |
| `404`  | No app has this `clientId`.                                                                                                    |
| `409`  | The app is essential: disabling it would leave the Owner no way in. Re-enabling one stays allowed.                             |

Exercised end to end by [`any_sent_disabled_at_disables_now_with_the_servers_time`](<../../Integration Tests/Client Management Explanation.md#any_sent_disabled_at_disables_now_with_the_servers_time>), [`disable_and_enable_are_idempotent`](<../../Integration Tests/Client Management Explanation.md#disable_and_enable_are_idempotent>), [`a_body_without_disabled_at_is_rejected_and_writes_nothing`](<../../Integration Tests/Client Management Explanation.md#a_body_without_disabled_at_is_rejected_and_writes_nothing>), [`an_essential_client_cannot_be_disabled`](<../../Integration Tests/Client Management Explanation.md#an_essential_client_cannot_be_disabled>), [`an_unknown_client_is_a_404_either_way`](<../../Integration Tests/Client Management Explanation.md#an_unknown_client_is_a_404_either_way>) and [`a_disabled_client_is_refused_at_authorize_until_re_enabled`](<../../Integration Tests/Client Management Explanation.md#a_disabled_client_is_refused_at_authorize_until_re_enabled>).

## `browser_sessions::router`

`GET /authorization/browser-sessions` lists, `DELETE /authorization/browser-sessions/{sid}` revokes one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/mod.rs router}}

## `handle_list_browser_sessions`

`GET /authorization/browser-sessions`. **Every browser signed in right now**, newest first: neither revoked nor expired. Each says which kind it is (an Owner browser or an approved one), its name, when it began, when it ends and when it was last seen, and **whether it is the caller's own**, the session the caller's token was minted under. Through `Scoped<LiveBrowserSessionsReader>` ([`list_live`](<../../Capabilities/Access/Browser Sessions Explanation.md#list_live>)); the caller's `sid` comes from `Authenticated<LiveSessionReader>`, which reads only the caller's own claims.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs handle_list_browser_sessions}}

The body leaves out the session's scopes, and its `revoked_at`, which is always empty on a live session:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/list_all.rs BrowserSessionBody}}

Exercised end to end by [`the_browsers_list_shows_live_sessions_and_revokes_one`](<../../Integration Tests/Browser Sessions Explanation.md#the_browsers_list_shows_live_sessions_and_revokes_one>) and [`the_browsers_routes_are_scope_gated`](<../../Integration Tests/Browser Sessions Explanation.md#the_browsers_routes_are_scope_gated>).

## `handle_revoke_browser_session`

`DELETE /authorization/browser-sessions/{sid}`. **Revoking a browser session ends everything minted under it**: the browser's own token, and every access token and refresh family an app it signed in to holds. The caller may revoke its own session, which signs that browser out. Through `Scoped<LiveBrowserSessionsRevoker>` ([`revoke`](<../../Capabilities/Access/Browser Sessions Explanation.md#revoke>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/browser_sessions/revoke_by_id.rs handle_revoke_browser_session}}

The answer is `204 No Content`, or `404` when no standing session has the `sid` (none ever did, or it is already revoked).

Exercised end to end by [`revoking_the_caller_s_own_session_signs_it_out`](<../../Integration Tests/Browser Sessions Explanation.md#revoking_the_caller_s_own_session_signs_it_out>) and [`an_app_authorized_in_a_session_is_ended_with_it`](<../../Integration Tests/Browser Sessions Explanation.md#an_app_authorized_in_a_session_is_ended_with_it>).
