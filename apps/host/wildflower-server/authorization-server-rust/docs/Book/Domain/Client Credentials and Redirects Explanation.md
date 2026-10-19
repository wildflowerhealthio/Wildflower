# Client Credentials and Redirects

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs}}

Three small facts about [clients](<Client Explanation.md>) that the bigger entities lean on. What an app **presents** when it authenticates at `/oauth/token`. Where the browser goes **back to the app** once an authorization-code request is settled, either way. And which clients the Owner **can't switch off**, because they are how the Owner gets in.

## `ClientCredentials`

The `client_id` and `client_secret` an app presents (RFC 6749 §2.3.1), as the domain sees them: which app, and the secret it claims. A public app presents no secret. How the pair arrived, in a Basic header or the form body, is a transport fact the HTTP layer keeps to itself; the domain gets only the pair. The [authenticated-client proof](<../Authority/Authenticated Client Explanation.md>) checks it against the app's row.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs ClientCredentials}}

**The plaintext secret is scrubbed from memory when the value is dropped** (`ZeroizeOnDrop`), so it doesn't sit on the heap after the request that checked it. That shortens the window; it doesn't remove every copy, since the raw request body and header still pass through axum's buffers. The `client_id` isn't secret and is skipped.

**A secret never reaches a log line.** `Debug` shows whether a secret was presented, never its value:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs ClientCredentials::fmt}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs tests::debug_redacts_client_secret}}

A presented secret renders as `<redacted>`, its value nowhere in the output, and the `client_id` still shows.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_credentials.rs tests::debug_shows_absent_client_secret_as_none}}

No secret renders as `None`, distinct from a redacted one.

## The client callback

An authorization-code request ends with the browser sent back to the app's `redirect_uri` (RFC 6749 §4.1.2): with a `code` and the app's `state` when it was approved, or with an `error`, an `error_description` and the `state` when it wasn't. These builders are the one place that URL is made. `/oauth/authorize`, the wait page's status poll, the Owner's consent decision and the limited page's cancel all hand back the URL built here, so the app sees the same shape whichever path settled its request.

They take a `redirect_uri` that is already parsed and already trusted: deciding whether a redirect may receive anything is the [registration's](<Client Explanation.md#allows_redirect_uri>) job, not theirs.

## `build_client_redirect_url`

**The approved request's callback**: the redirect with `code` and `state` appended. A query the app registered on its redirect is kept, and the two pairs follow it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs build_client_redirect_url}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs tests::success_redirect_appends_code_and_state}}

The code and state are appended in that order.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs tests::success_redirect_preserves_existing_query}}

The redirect's own `keep=1` stays first.

## `build_client_error_redirect_url`

**The refused request's callback**: the redirect with `error`, `error_description` and `state`, in that order (RFC 6749 §4.1.2.1). The error is an [`OAuthErrorCode`](<Errors Explanation.md#oautherrorcode>), so it can only be one of the codes the spec allows. The description is always one of the server's fixed sentences, an [`OAuthErrorKind`](<Errors Explanation.md#description>) description or one of the three below, never anything from the request.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs build_client_error_redirect_url}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs tests::error_redirect_appends_error_description_and_state_in_order}}

A decline carries `access_denied`, the decline sentence form-encoded, then the state.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs tests::error_redirect_preserves_existing_query}}

The redirect's own query stays first here too, and an apostrophe in the sentence is percent-encoded.

## `SCOPES_NOT_REGISTERED_DESCRIPTION`

Sent with `invalid_scope` when an app whose registration is fixed (a server-defined one) asks for a scope outside it. `/authorize` refuses that request outright rather than asking the Owner, since an approval could never widen the registration (see [`scopes_are_registered`](<Client Explanation.md#scopes_are_registered>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs SCOPES_NOT_REGISTERED_DESCRIPTION}}

## `BROWSER_SIGNED_OUT_DESCRIPTION`

Sent with `access_denied` when the approval arrives after the browser session the request was made in was signed out. The approval denies the request instead of issuing a code, and the app is told why.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs BROWSER_SIGNED_OUT_DESCRIPTION}}

## `REQUEST_DECLINED_DESCRIPTION`

Sent with `access_denied` when the Owner declines, or the person at the browser cancels on the limited page. The wait page's status poll sends it for every denial: it can't tell a decline from a signed-out browser session, so every denial reads as declined.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs REQUEST_DECLINED_DESCRIPTION}}

All three are checked to be valid `error_description` text by [`every_description_is_a_valid_error_description`](<Errors Explanation.md#description>).

## `EssentialClientGuard`

**Some clients the Owner can't lose without being locked out**, so the server won't let them be disabled. There are two. The Wildflower host app's client is how the Owner reaches the server at all. The browser-session client is how a browser on the Owner's device signs in as the Owner. The Owner's list of clients flags both as `essential`, and the disable operation refuses them with `EssentialClient` (a 409). Re-enabling one is still allowed, so a row disabled by hand in the database can be recovered.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs EssentialClientGuard}}

The guard is built once at setup, from the configured host app `client_id` and the fixed browser-session `client_id`, and handed to the client capabilities ([Clients](<../Capabilities/Access/Clients Explanation.md>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs EssentialClientGuard::new}}

## `is_essential`

Whether a `client_id` is one of the two. Matched exactly.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs EssentialClientGuard::is_essential}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/essential_client_guard.rs tests::only_the_host_app_s_and_the_browser_session_clients_are_essential}}

The host app's and the browser-session client's ids are essential; an id that merely starts with the host app's, and any other app, are not.

Exercised end to end by [`an_essential_client_cannot_be_disabled`](<../Integration Tests/Client Management Explanation.md#an_essential_client_cannot_be_disabled>).
