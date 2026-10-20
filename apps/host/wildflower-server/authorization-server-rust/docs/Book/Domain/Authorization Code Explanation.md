# Authorization Code

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs}}

An authorization code carries an approved [code request](<Authorization Request/Code Request Explanation.md>) from the browser to the app's back end. The browser is sent back to the app's redirect URI with the code in the URL; the app's back end then trades the code at `/oauth/token` for tokens. The URL holds only the code, never a token, and the code is worth nothing to anyone who sees it without the app's PKCE verifier.

**A code lives 60 seconds and is redeemed once.** It is issued in one place, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code}}, on either authority, the Owner's approval or a [standing grant](<Grant Explanation.md#when-a-grant-skips-the-owner>), and everything the redemption will check is fixed on it then.

## Redeemed once

Redemption reads and deletes the code in one statement, so of two redemptions of the same code only one gets it back. The other sees nothing, just as for a code that was never issued:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs RedeemedAuthorizationCode::redeem from="// A concurrent redemption" through="let Some(code)"}}

**A code presented a second time ends what the first redemption started.** The [refresh family](<Refresh Token Explanation.md>) a redemption begins records a hash of its code, and a code that comes back unknown expires every family carrying that hash before the refusal. A code stolen and replayed after the app redeemed it therefore takes the app's refresh token down with it; the app runs the flow again. A code that never existed matches no family, and the refusal is the same `invalid_grant` either way.

A request too malformed to check (a verifier of the wrong length, a redirect that isn't a URL) is refused before the code is touched. Past that, the code is spent whatever happens next: a redemption that names the wrong app or redirect, arrives late, or fails PKCE has already deleted it. [`auth_code_grant_replay_rejected`](<../Integration Tests/Grant Flows Explanation.md>) and [`auth_code_replay_revokes_issued_refresh_family`](<../Integration Tests/Grant Flows Explanation.md>) hold the server to both rules.

## The client callback

A code request ends with the browser sent back to the app's `redirect_uri` (RFC 6749 §4.1.2): with a `code` and the app's `state` when it was approved, or with an `error`, an `error_description` and the `state` when it wasn't. These builders are the one place that URL is made. `/oauth/authorize`, the wait page's status poll, the Owner's consent decision and the limited page's Cancel all hand back the URL built here, so the app sees the same shape whichever path settled its request.

They take a `redirect_uri` that is already parsed and already trusted: deciding whether a redirect may receive anything is the [registration's](<Client Explanation.md#item-Client--allows_redirect_uri>) job, not theirs.

## `domain::authorization_code`

### `AuthorizationCode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs AuthorizationCode}}

### `AUTHORIZATION_CODE_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_code.rs AUTHORIZATION_CODE_TTL}}

## `domain::client_redirect`

### `build_client_redirect_url`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs build_client_redirect_url tests="tests::success_redirect_appends_code_and_state tests::success_redirect_preserves_existing_query"}}

### `build_client_error_redirect_url`

The error is an [`OAuthErrorCode`](<Errors Explanation.md#item-OAuthErrorCode>), so it can only be one of the codes the spec allows.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs build_client_error_redirect_url tests="tests::error_redirect_appends_error_description_and_state_in_order tests::error_redirect_preserves_existing_query"}}

### The fixed descriptions

Besides an [`AuthorizeRefusal`](<Errors Explanation.md#item-AuthorizeRefusal>)'s sentence, an `error_description` is one of these three. [`every_description_is_a_valid_error_description`](<Errors Explanation.md#item-AuthorizeRefusal--description>) checks them too.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs SCOPES_NOT_REGISTERED_DESCRIPTION}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs BROWSER_SIGNED_OUT_DESCRIPTION}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/client_redirect.rs REQUEST_DECLINED_DESCRIPTION}}
