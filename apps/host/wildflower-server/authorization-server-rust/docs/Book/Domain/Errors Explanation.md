# Errors

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs}}

The server says no in four vocabularies, one per audience. **None of them knows about HTTP**: each is a domain fact, and the HTTP layer decides the status and the body ([Errors and Wire Shapes](<../HTTP/Errors and Wire Shapes Explanation.md>)).

| Vocabulary                 | Who hears it                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| `AuthorizationServerError` | The Owner's UI on the `/authorization` surface, and every operation when the store fails.      |
| `OAuthErrorCode`           | An app, as the `error` of an OAuth response: from `/oauth/token`, or on its callback redirect. |
| `OAuthErrorKind`           | The person at the browser, or the app, when `/oauth/authorize` refuses a request.              |
| `TokenExchangeError`       | An app at `/oauth/token`, and the operator's log, which gets the specific reason.              |

## `AuthorizationServerError`

The domain's failure vocabulary: a small set of **semantic** outcomes the Owner's UI acts on, plus one opaque **infrastructure** failure. Every capability fails with it, and so does the store, which turns its database errors into `Infrastructure` before they leave it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError}}

| Variant                        | What happened                                                                                                                                                                                  | On the wire                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `OAuthConsentNotFound`         | No pending, unexpired authorization-code consent has this id.                                                                                                                                  | 404, keyed by `id`                           |
| `DeviceConsentNotFound`        | No pending, unexpired device-code consent has this user code.                                                                                                                                  | 404, keyed by the user code                  |
| `GrantNotFound`                | No standing grant has this id.                                                                                                                                                                 | 404, keyed by `id`                           |
| `BrowserSessionNotFound`       | No standing browser session has this `sid`.                                                                                                                                                    | 404, keyed by `sid`                          |
| `ClientNotFound`               | No registered client has this `client_id`.                                                                                                                                                     | 404, keyed by the `client_id`                |
| `AuthorizationRequestNotFound` | No authorization request has this id (the wait page's poll).                                                                                                                                   | 404, keyed by `id`                           |
| `EssentialClient`              | The Owner tried to disable an [essential client](<Client Credentials and Redirects Explanation.md#essentialclientguard>). Nothing is written.                                                  | 409                                          |
| `RegistrationNotAcknowledged`  | The Owner approved a request from a new app, or one stepping outside its registration, without [acknowledging](<Client Explanation.md#needs_acknowledgement>) the warning. Nothing is written. | 409                                          |
| `LaunchPatientMismatch`        | The Owner approved a request whose launch bound a patient, naming another patient or none. Nothing is written.                                                                                 | 409                                          |
| `InsufficientScope`            | The caller's token doesn't cover the scopes the operation needs, or an approver lacks one of the request's approval scopes. Carries the missing scopes.                                        | 403 `InsufficientScope`                      |
| `InsufficientApproverScope`    | An approver tried to grant more than they hold: you can't delegate what you don't have. Carries what the approval would grant beyond the approver's token.                                     | 403, the same `InsufficientScope` body       |
| `Infrastructure`               | The store failed (a lock, a query, a row that won't map). Its cause is kept as text, so this type never carries a database error type.                                                         | Empty 500; `context` and `source` are logged |

Each semantic 4xx renders as JSON naming the variant in `error`, with the identifying field beside it, so the Owner's UI can tell which thing went missing.

`Display` gives each variant an operator-readable sentence for the logs. `Error` is implemented by hand beside it, not derived, because `Infrastructure`'s field is called `source` and is text, not an error source.

No unit tests in this file; the variants are exercised by the capabilities that raise them and by the integration tests that read them off the wire.

## `infrastructure`

**How a store failure enters the domain**: wrap the cause's text with a fixed `context` saying what was being done. The store calls this at every failure point, so its error types stop at the adapter.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError::infrastructure}}

No unit test of its own.

## Missing scopes

The scope gate's own rejection, `MissingScopes` from the `Scoped` extractor, becomes `InsufficientScope`, so it reaches the wire through the same rendering as any other failure.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError::from}}

## `OAuthErrorCode`

**The closed set of OAuth `error` codes the server may send**: RFC 6749 §5.2's token-endpoint codes, §4.1.2.1's `access_denied` and `unsupported_response_type` for the authorization redirect, and RFC 8628 §3.5's device-flow polling codes. An enum, so a code can't be mistyped into something the spec doesn't allow at any place an error is built. Its string form is the exact wire value.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs OAuthErrorCode}}

| Code                        | Meaning                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `invalid_request`           | A parameter is missing, malformed or otherwise invalid.                       |
| `invalid_client`            | Client authentication failed.                                                 |
| `invalid_grant`             | The code, refresh token or device code is invalid, expired, revoked or wrong. |
| `unauthorized_client`       | The app may not use this grant type.                                          |
| `invalid_scope`             | The scope is invalid, unknown, or more than the app may hold.                 |
| `unsupported_response_type` | `/authorize` was asked for something other than a code.                       |
| `server_error`              | The server failed.                                                            |
| `access_denied`             | The request was declined or ended.                                            |
| `authorization_pending`     | The device request still waits for the Owner; keep polling.                   |
| `slow_down`                 | The device is polling too fast; back off.                                     |
| `expired_token`             | The device code has expired.                                                  |

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs tests::as_ref_matches_rfc_wire_values}}

Every variant's string is its exact RFC value, so a rename can't silently change what ships.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs tests::display_matches_as_ref}}

`Display` and `AsRef<str>` agree for every variant, so either can be used.

## `OAuthErrorKind`

**Why `/oauth/authorize` refused a request.** RFC 6749 §4.1.2.1 lets a refusal go back to the app only once its `redirect_uri` is trusted. Before that point, or for a redirect nobody has vouched for, the refusal is a local page in the browser, titled for the kind, with the kind's sentence as its body. Once the redirect is trusted, the same sentence goes back to the app as the `error_description`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs OAuthErrorKind}}

| Kind                             | The request                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `InvalidRedirectUri`             | Its `redirect_uri` isn't a well-formed URL.                                                            |
| `InvalidScheme`                  | Its `redirect_uri` isn't `http` or `https`.                                                            |
| `DisabledClient`                 | Comes from a disabled app.                                                                             |
| `RedirectUriNotAllowed`          | Its `redirect_uri` isn't on a server-defined registration.                                             |
| `UnsupportedResponseType`        | Asks for a `response_type` other than `code`.                                                          |
| `UnsupportedCodeChallengeMethod` | Uses a PKCE method other than `S256`.                                                                  |
| `InvalidCodeChallenge`           | Carries a malformed S256 challenge.                                                                    |
| `LaunchUnknown`                  | Names a launch this app may not see: never minted, pruned, or another app's, which reads the same way. |
| `LaunchAlreadyUsed`              | Names this app's launch, already consumed.                                                             |
| `LaunchExpired`                  | Names this app's launch, past its expiry.                                                              |
| `InvalidAudience`                | Its `aud` isn't this server's origin.                                                                  |

## Test fixtures

The tests check sentences against RFC 6749 §4.1.2.1's grammar for an `error_description`: printable ASCII without `"` or `\`, and not empty.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs tests::is_error_description}}

## `description`

The sentence saying why: the local page's body, and the `error_description` when the refusal goes back to the app. **Every sentence is a fixed string, never request input, and valid `error_description` text**, so nothing an attacker sends is echoed back and no sentence breaks the redirect's grammar.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs OAuthErrorKind::description}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs tests::every_description_is_a_valid_error_description}}

Every kind's sentence passes, and so do the three fixed sentences of the [client callback](<Client Credentials and Redirects Explanation.md#the-client-callback>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_kind.rs tests::a_quote_backslash_or_non_ascii_is_not_an_error_description}}

The check itself refuses a quote, a backslash, a non-ASCII letter, a tab and the empty string.

## `InvalidGrantReason`

**Why a grant presented at `/oauth/token` was refused as `invalid_grant`**, in specific terms. The specific reason goes to the operator's log; it carries only what an operator needs to tell the cases apart, never the code, verifier, challenge or token.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs InvalidGrantReason}}

**The app hears less than the log.** The HTTP layer collapses the reasons onto a few generic descriptions, so a response doesn't say which check a code failed:

| Reasons                                                                                               | The app is told                   |
| ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| `CodeNotFoundOrRedeemed`, `CodeClientMismatch`, `CodeRedirectMismatch`, `CodeExpired`, `PkceMismatch` | `Invalid authorization grant`     |
| `DeviceRequestNotFound`                                                                               | `Unknown device_code`             |
| `DeviceCodeAlreadyRedeemed`                                                                           | `Device code already redeemed`    |
| `RefreshTokenNotFound`, `RefreshTokenClientMismatch`, `RefreshTokenVanished`                          | `Invalid refresh_token parameter` |
| `RefreshTokenExpired`                                                                                 | `Refresh token has expired`       |
| `RefreshTokenReplayed`, `RefreshTokenSessionRevoked`, `RefreshTokenClientRevoked`                     | `Refresh token has been revoked`  |

A refresh token presented by the wrong app reads exactly like an unknown one, so a stranger can't probe whether a token is live. Two reasons record what was done as well as what was found: a code that is unknown or already redeemed revokes any refresh family minted from it (a possible replay), and a consumed refresh token presented again revokes its whole family.

## `TokenExchangeError`

**The ways a token exchange can fail.** All but the last two are the app's fault and render as a 400 with the matching OAuth code; `Issuance` and `Store` are the server's.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs TokenExchangeError}}

| Variant                 | Code                    | Meaning                                                                                                                           |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `UnauthorizedGrantType` | `unauthorized_client`   | The app's registration doesn't allow this grant type.                                                                             |
| `InvalidCodeVerifier`   | `invalid_grant`         | The PKCE verifier isn't 43 to 128 characters (RFC 7636 §4.1).                                                                     |
| `InvalidRedirectUri`    | `invalid_request`       | The presented `redirect_uri` doesn't parse.                                                                                       |
| `InvalidGrant`          | `invalid_grant`         | The grant was refused, for the reason above.                                                                                      |
| `ExpiredToken`          | `expired_token`         | The device request has expired.                                                                                                   |
| `AuthorizationPending`  | `authorization_pending` | The device request still waits for the Owner.                                                                                     |
| `AccessDenied`          | `access_denied`         | The device request was denied.                                                                                                    |
| `SlowDown`              | `slow_down`             | The device polled too fast.                                                                                                       |
| `Issuance`              | `server_error` (500)    | The grant was accepted but the token couldn't be signed; the exchange's write scope rolled back with it, so nothing was consumed. |
| `Store`                 | empty 500, logged       | A store read or write failed.                                                                                                     |

An `AuthorizationServerError` from the store becomes `Store`, and a token signing failure becomes `Issuance`, so the exchange flows can use `?` on either. No unit tests in this file; the [token exchanger](<../Capabilities/OAuth/Token Exchanger Explanation.md>) and the [redemption proofs](<../Authority/Redemption Explanation.md>) raise each variant in theirs.
