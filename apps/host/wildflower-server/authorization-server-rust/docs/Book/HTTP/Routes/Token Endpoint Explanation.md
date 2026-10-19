# Token Endpoint

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs}}

The token endpoint is where an app's back end, not a browser, gets its tokens. It trades an authorization code, a device code or a refresh token for an access token (RFC 6749 §3.2, RFC 8628 §3.4), and `POST /oauth/revoke` beside it takes one of the app's tokens back (RFC 7009). **Every call is made by a client, and the client is authenticated before the handler runs.** A public client proves itself by its `client_id` alone, a confidential one by its secret too.

Three routes take this shape: `/oauth/token`, `/oauth/revoke` and [`/oauth/device_authorization`](<Device Authorization Explanation.md#handle_device_authorization_request>). Each reads a form-encoded body through one extractor, [`TokenRequest`](#tokenrequest), which hands the handler the parsed body and an [`AuthenticatedClient`](<../../Authority/Authenticated Client Explanation.md>) proof. A handler can't act for a client whose secret was never checked, because it never sees raw credentials. Every answer, success or error, is uncached (RFC 6749 §5.1).

## `TokenRequest`

A token-style request, extracted once: the endpoint's own `payload`, and the authenticated client.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs TokenRequest}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs TokenRequest::from_request}}

The steps, each failing as a [`TokenError`](#tokenerror):

1. The body must be form-encoded ([`require_form_urlencoded_content_type`](#require_form_urlencoded_content_type)): `400 invalid_request` otherwise.
2. The body is read once, and parsed into the payload: a body that doesn't parse is `400 invalid_request`, "Malformed payload". This comes before the credentials, so a malformed body reads as malformed, not as "Missing client_id".
3. The credentials are read from the `Authorization` header and the same body ([`resolve_client_credentials`](#resolve_client_credentials)).
4. The client is authenticated, through [`ClientAuthenticator::authenticate`](<../../Capabilities/OAuth/Client Authenticator Explanation.md#authenticate>). A failure carries how the credentials were presented, so a Basic attempt gets its challenge ([`ClientAuthenticationFailure`](#clientauthenticationfailure)).

The payload and the credentials are two parses of the same small string. They read disjoint fields, so the payload types ignore `client_id` and `client_secret`, and the credential parse ignores the rest.

## `require_form_urlencoded_content_type`

**RFC 6749 §3.2 requires `application/x-www-form-urlencoded`.** The media type is matched alone, ignoring case and any `; charset=…`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs require_form_urlencoded_content_type}}

### What it looks like

`headers_with_content_type` builds headers carrying one `Content-Type`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::headers_with_content_type}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::accepts_exact_form_urlencoded}}

The exact type passes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::accepts_form_urlencoded_with_charset_and_mixed_case}}

So does the type in mixed case, with a charset.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::rejects_other_content_types}}

JSON is refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs tests::rejects_a_missing_content_type}}

So is a request with no `Content-Type`.

Exercised end to end by [`token_exchange_rejects_non_form_content_type`](<../../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_rejects_non_form_content_type>).

## Test fixtures

The credential tests build the expected answer with `presented`, and a Basic header with `basic_authorization`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::presented}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_authorization}}

## `resolve_client_credentials`

A client presents its credentials one of two ways (RFC 6749 §2.3.1): the HTTP Basic `Authorization` header (`client_secret_basic`), or `client_id` and `client_secret` in the form body (`client_secret_post`). **The header wins; the body is the fallback; a secret both ways is refused**, since §2.3 forbids more than one authentication method per request. A body `client_id` beside the header is tolerated when it names the same client, as some client libraries always send it. With no `client_id` anywhere, the request is refused. Checking the credentials is the domain's job; this only reads them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs resolve_client_credentials}}

The answer is the domain's [`ClientCredentials`](<../../Domain/Client Credentials and Redirects Explanation.md>), plus the one transport fact the domain doesn't need: how they were presented, which decides whether a `401` carries a Basic challenge.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs PresentedCredentials}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ClientAuthenticationMethod}}

A secret that is read but never makes it into the answer, a body secret beside a Basic header say, is scrubbed from memory when it is dropped:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BodyClientCredentials}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BasicCredentials}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::resolves_body_credentials_when_no_authorization_header}}

Without a header, the body's `client_id` and secret are read, presented in the body.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::resolves_basic_header_credentials}}

With a Basic header and no body credentials, the header's are read, presented by Basic.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_alongside_body_client_secret_is_invalid_request}}

A body secret beside a Basic header is `invalid_request`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_with_matching_body_client_id_is_allowed}}

A body `client_id` naming the Basic client is allowed, and the method is still Basic.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_with_mismatched_body_client_id_is_invalid_request}}

A body `client_id` naming another client is `invalid_request`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::missing_client_id_everywhere_is_invalid_request}}

No header and no body `client_id` is `invalid_request`.

Exercised end to end by the [Client Auth](<../../Integration Tests/Client Auth Explanation.md>) tests, among them [`token_exchange_with_basic_auth_redeems_refresh_token`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_with_basic_auth_redeems_refresh_token>), [`token_exchange_basic_plus_body_secret_returns_400_invalid_request`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_basic_plus_body_secret_returns_400_invalid_request>) and [`token_exchange_missing_client_id_returns_400_invalid_request`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_missing_client_id_returns_400_invalid_request>).

## `decode_basic_authorization_header`

The header's value read as Basic credentials (RFC 6749 §2.3.1): base64, then UTF-8, then split at the first colon, then each half form-decoded. The scheme is matched without regard to case. **A header with another scheme is no Basic attempt**, and the body is read instead; a Basic header that won't decode is a malformed attempt.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs decode_basic_authorization_header}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs try_decode_basic_payload}}

Each half was form-encoded before the pair was base64-encoded, so `+` is a space and `%2B` a plus:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs form_urlencoded_decode_credential_component}}

The decoded pair and its copies hold the plaintext secret, and are scrubbed when they are dropped, the bytes of a pair that isn't UTF-8 included.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_scheme_match_is_case_insensitive}}

`bASIC` is Basic.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::non_basic_authorization_scheme_falls_back_to_body}}

A `Bearer` header is ignored, and the body's credentials are read.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_halves_are_form_urlencoded_decoded}}

`app%2Bone` decodes to `app+one`, and `p%40ss+word%25` to `p@ss word%`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::basic_password_keeps_text_after_first_colon}}

A secret holding a colon is kept whole.

Exercised end to end by [`token_exchange_basic_secret_with_reserved_characters_round_trips`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_basic_secret_with_reserved_characters_round_trips>).

## `ResolveClientCredentialsError`

Why the credentials couldn't be read, before any store is asked. A request that breaks §2.3 (credentials both ways, a contradicting `client_id`, no `client_id`) is the caller's mistake, a `400 invalid_request`. **A Basic header that won't decode is a failed authentication**, a `401 invalid_client` carrying the `WWW-Authenticate: Basic` challenge §5.2 requires for a header-based attempt.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ResolveClientCredentialsError}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ResolveClientCredentialsError::into_response}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BASIC_AUTH_CHALLENGE}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs tests::malformed_basic_header_is_invalid_client_with_challenge}}

Bad base64, a pair with no colon, bytes that aren't UTF-8, and a percent-escape decoding to a bad byte are each a malformed Basic attempt, rendered as a `401` with the challenge.

## `ClientAuthenticationFailure`

The domain's [`ClientAuthenticationError`](<../../Authority/Authenticated Client Explanation.md>) and how the client presented its credentials. **The caller's mistakes are a `401 invalid_client`** naming the check that failed: an unknown client, a disabled one, a secret not configured, a secret missing or wrong. A Basic attempt's `401` carries the challenge, a body attempt's doesn't. A secret that couldn't be verified, or a client row that couldn't be read, is the server's failure: logged, and a `500 server_error` saying nothing more.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs ClientAuthenticationFailure}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs ClientAuthenticationFailure::into_response}}

No unit test of its own. Exercised end to end by [`token_exchange_wrong_basic_secret_returns_401_with_basic_challenge`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_wrong_basic_secret_returns_401_with_basic_challenge>), [`token_exchange_body_secret_failure_has_no_basic_challenge`](<../../Integration Tests/Client Auth Explanation.md#token_exchange_body_secret_failure_has_no_basic_challenge>) and [`device_authorization_unknown_client_returns_401`](<../../Integration Tests/OAuth Endpoints Explanation.md#device_authorization_unknown_client_returns_401>).

## `OAuthErrorResponse`

An RFC 6749 §5.2 error body ([`OAuthError`](<../Errors and Wire Shapes Explanation.md#oautherror>)) and the status it is sent at: the shape every OAuth error response shares. `new` builds one from a code and an optional description; `server_error` is the `500 server_error` a flow answers when the server fails partway. On its own it isn't cache-suppressed: the status poll uses it that way, and the token routes wrap it in [`TokenError`](#tokenerror), which is.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::new}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::server_error}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::into_response}}

No unit test of its own.

## `TokenError`

The error side of the token-style routes, and the extractor's rejection. **Every variant renders uncached.** A fallible step bails with `?`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::into_response}}

Three constructors cover what the routes build by hand: a `400` with a code and a description, a `500 server_error` with a JSON body, and a logged, opaque `500`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::bad_request}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::server_error}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::internal}}

The rest come by conversion. A credential error and an authentication failure keep their own rendering. A store failure ([`AuthorizationServerError`](<../../Domain/Errors Explanation.md>)) becomes the logged, opaque `500`. A failed exchange ([`TokenExchangeError`](<../../Capabilities/OAuth/Token Exchanger Explanation.md>)) maps onto RFC 6749 §5.2 and RFC 8628 §3.5:

| Exchange error          | Response                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `UnauthorizedGrantType` | `400 unauthorized_client`, "Client may not use this grant type"                                                    |
| `InvalidCodeVerifier`   | `400 invalid_grant`, "Invalid code_verifier parameter"                                                             |
| `InvalidRedirectUri`    | `400 invalid_request`, "Invalid redirect_uri parameter"                                                            |
| `InvalidGrant(reason)`  | `400 invalid_grant`, one description per family of reasons (below); the reason itself is logged                    |
| `ExpiredToken`          | `400 expired_token`                                                                                                |
| `AuthorizationPending`  | `400 authorization_pending`                                                                                        |
| `AccessDenied`          | `400 access_denied`                                                                                                |
| `SlowDown`              | `400 slow_down`                                                                                                    |
| `Issuance`              | `500 server_error`: "Failed to sign JWT" when signing failed, "No JSON Web Keys available to sign token" otherwise |
| `Store`                 | a logged, opaque `500`                                                                                             |

**The wire doesn't say which check refused a code.** Wrong client, wrong `redirect_uri`, expired, wrong verifier and already redeemed all read "Invalid authorization grant", since telling them apart would leak facts about a code that may be another client's. The reason carries no secret, so it is logged, and the operator can still tell them apart.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs invalid_grant_description}}

Exercised end to end by [`token_exchange_unknown_code_returns_400_invalid_grant`](<../../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_unknown_code_returns_400_invalid_grant>), [`token_exchange_error_sets_cache_suppression_headers`](<../../Integration Tests/OAuth Endpoints Explanation.md#token_exchange_error_sets_cache_suppression_headers>), [`auth_code_grant_replay_rejected`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_replay_rejected>) and [`device_grant_pending_then_slow_down`](<../../Integration Tests/Device Code Explanation.md#device_grant_pending_then_slow_down>).

## `handle_token_request`

`POST /oauth/token`. The body names its grant in `grant_type`, and the handler hands it to the matching exchange: an authorization code with its PKCE verifier and `redirect_uri` ([`exchange_authorization_code`](<../../Capabilities/OAuth/Token Exchanger Explanation.md#exchange_authorization_code>)), a device's code while it polls ([`exchange_device_code`](<../../Capabilities/OAuth/Token Exchanger Explanation.md#exchange_device_code>)), or a refresh token for an access token and the refresh token's successor ([`exchange_refresh_token`](<../../Capabilities/OAuth/Token Exchanger Explanation.md#exchange_refresh_token>)). Each exchange takes the authenticated client.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs TokenPayload}}

A `grant_type` the endpoint doesn't take fails to parse, so it is the extractor's `400 invalid_request`, "Malformed payload".

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs handle_token_request}}

The success body is RFC 6749 §5.1's, with SMART's `patient` when the grant binds one ([`TokenResponse`](<../Errors and Wire Shapes Explanation.md#tokenresponse>)):

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs token_response}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs tests::token_payload_tolerates_unparsed_client_credential_fields}}

A refresh body carrying `client_id` and `client_secret` (`client_secret_post`) still parses: the payload ignores them.

Exercised end to end by [`auth_code_grant_happy_path_end_to_end`](<../../Integration Tests/Grant Flows Explanation.md#auth_code_grant_happy_path_end_to_end>), [`device_grant_single_use_then_expired_token`](<../../Integration Tests/Device Code Explanation.md#device_grant_single_use_then_expired_token>), [`offline_access_issues_rotating_refresh_token`](<../../Integration Tests/Device Code Explanation.md#offline_access_issues_rotating_refresh_token>), [`token_endpoint_rejects_grant_outside_client_allow_list`](<../../Integration Tests/Device Code Explanation.md#token_endpoint_rejects_grant_outside_client_allow_list>) and [`the_token_endpoint_cannot_mint_a_browser_token`](<../../Integration Tests/Browser Pairing Explanation.md#the_token_endpoint_cannot_mint_a_browser_token>).

## `handle_token_revocation_request`

`POST /oauth/revoke`: an app hands back one of its own tokens. **The answer is `200` whether the token was revoked, was already dead, or was never this client's** (RFC 7009 §2.2), so a client learns nothing about tokens that aren't its own. The body is the token alone:

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs TokenRevocationPayload}}

`token_type_hint` is accepted and never read: [`ClientTokenRevoker::revoke`](<../../Capabilities/OAuth/Client Token Revoker Explanation.md#revoke>) tells the token's type from the token, ending a refresh token's family or denylisting an access token, and only when it is the authenticated client's.

{{#code apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs handle_token_revocation_request}}

A malformed request and a failed authentication are refused by the extractor as at `/oauth/token`. A store that can't be read or written is the logged, opaque `500`.

Exercised end to end by [`an_app_revokes_its_own_refresh_token`](<../../Integration Tests/Token Revocation Explanation.md#an_app_revokes_its_own_refresh_token>), [`an_app_revokes_its_own_access_token`](<../../Integration Tests/Token Revocation Explanation.md#an_app_revokes_its_own_access_token>), [`another_client_s_tokens_are_answered_alike_and_left_alone`](<../../Integration Tests/Token Revocation Explanation.md#another_client_s_tokens_are_answered_alike_and_left_alone>), [`unknown_and_dead_tokens_get_200`](<../../Integration Tests/Token Revocation Explanation.md#unknown_and_dead_tokens_get_200>), [`a_wrong_token_type_hint_still_revokes`](<../../Integration Tests/Token Revocation Explanation.md#a_wrong_token_type_hint_still_revokes>), [`an_unknown_client_is_invalid_client`](<../../Integration Tests/Token Revocation Explanation.md#an_unknown_client_is_invalid_client>) and [`a_malformed_request_is_invalid_request`](<../../Integration Tests/Token Revocation Explanation.md#a_malformed_request_is_invalid_request>).
