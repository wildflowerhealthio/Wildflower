# Token Endpoint

{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs}}

The token endpoint is where an app's back end, not a browser, gets its tokens. It trades an [authorization code](<../../Domain/Authorization Code Explanation.md>), a device code or a [refresh token](<../../Domain/Refresh Token Explanation.md>) for an [access token](<../../Domain/Access Token Explanation.md>) (RFC 6749 §3.2, RFC 8628 §3.4), and `POST /oauth/revoke` beside it takes one of the app's tokens back (RFC 7009). **Every call is made by a client, and the client is authenticated before the handler runs.** A public client proves itself by its `client_id` alone, a confidential one by its secret too.

Three routes take this shape: `/oauth/token`, `/oauth/revoke` and `/oauth/device_authorization`, on the [next page](<Device Authorization Explanation.md>). Each reads a form-encoded body through one extractor, [`TokenRequest`](#item-TokenRequest), which hands the handler the parsed body and an [`AuthenticatedClient`](<../../Authority/Authenticated Client Explanation.md>) proof. A handler can't act for a client whose secret was never checked, because it never sees raw credentials. Every answer, success or error, is uncached (RFC 6749 §5.1). The [Client Auth](<../../Integration Tests/Client Auth Explanation.md>), [Grant Flows](<../../Integration Tests/Grant Flows Explanation.md>) and [Token Revocation](<../../Integration Tests/Token Revocation Explanation.md>) integration tests hold the routes end to end.

## `http::routes::oauth::token_request`

### `TokenRequest`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs TokenRequest}}

#### `from_request`

The payload is parsed before the credentials, so a malformed body reads as malformed, not as "Missing client_id". The client is authenticated through the [client authenticator](<../../Capabilities/OAuth/Client Authenticator Explanation.md>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs TokenRequest::from_request}}

### `FORM_URLENCODED`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs FORM_URLENCODED}}

### `require_form_urlencoded_content_type`

The tests build their headers with [`headers_with_content_type`](<../Test Fixtures Explanation.md#token-endpoint>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_request.rs require_form_urlencoded_content_type tests="tests::accepts_exact_form_urlencoded tests::accepts_form_urlencoded_with_charset_and_mixed_case tests::rejects_other_content_types tests::rejects_a_missing_content_type"}}

## `http::routes::oauth::client_auth`

A client presents its credentials one of two ways (RFC 6749 §2.3.1): the HTTP Basic `Authorization` header, or `client_id` and `client_secret` in the form body. **The header wins; the body is the fallback; a secret both ways is refused**, since §2.3 forbids more than one authentication method per request. Checking the credentials is the domain's job; this file only reads them. The tests build the expected answer with [`presented`](<../Test Fixtures Explanation.md#token-endpoint>) and a Basic header with [`basic_authorization`](<../Test Fixtures Explanation.md#token-endpoint>).

### `resolve_client_credentials`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs resolve_client_credentials tests="tests::resolves_body_credentials_when_no_authorization_header tests::resolves_basic_header_credentials tests::basic_alongside_body_client_secret_is_invalid_request tests::basic_with_matching_body_client_id_is_allowed tests::basic_with_mismatched_body_client_id_is_invalid_request tests::missing_client_id_everywhere_is_invalid_request"}}

### `PresentedCredentials`

The domain's [`ClientCredentials`](<../../Domain/Client Credentials Explanation.md#item-ClientCredentials>), and how they arrived.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs PresentedCredentials}}

### `ClientAuthenticationMethod`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ClientAuthenticationMethod}}

### `BodyClientCredentials`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BodyClientCredentials}}

### `BasicCredentials`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BasicCredentials}}

### `decode_basic_authorization_header`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs decode_basic_authorization_header tests="tests::basic_scheme_match_is_case_insensitive tests::non_basic_authorization_scheme_falls_back_to_body"}}

### `try_decode_basic_payload`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs try_decode_basic_payload tests="tests::basic_password_keeps_text_after_first_colon"}}

### `form_urlencoded_decode_credential_component`

Each half was form-encoded before the pair was base64-encoded, so `+` is a space and `%2B` a plus.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs form_urlencoded_decode_credential_component tests="tests::basic_halves_are_form_urlencoded_decoded"}}

### `MalformedBasicHeader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs MalformedBasicHeader}}

### `ResolveClientCredentialsError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ResolveClientCredentialsError}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs ResolveClientCredentialsError::into_response tests="tests::malformed_basic_header_is_invalid_client_with_challenge"}}

### `BASIC_AUTH_CHALLENGE`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/client_auth.rs BASIC_AUTH_CHALLENGE}}

## `http::routes::oauth::internal`

### `OAuthErrorResponse`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::new}}

#### `server_error`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::server_error}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs OAuthErrorResponse::into_response}}

### `TokenError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError}}

#### `bad_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::bad_request}}

#### `server_error`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::server_error}}

#### `internal`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::internal}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs TokenError::into_response}}

#### Conversions

The rest come by conversion. A credential error and an authentication failure keep their own rendering. A store failure ([`AuthorizationServerError`](<../../Domain/Errors Explanation.md#item-AuthorizationServerError>)) becomes the logged, opaque `500`. A failed exchange ([`TokenExchangeError`](<../../Domain/Errors Explanation.md#item-TokenExchangeError>)) maps onto RFC 6749 §5.2 and RFC 8628 §3.5: a wrong grant type is `400 unauthorized_client`; a bad verifier and an [`InvalidGrantReason`](<../../Domain/Errors Explanation.md#item-InvalidGrantReason>) are `400 invalid_grant`; a bad `redirect_uri` is `400 invalid_request`; a device poll's states are `400` with their own codes; a token that couldn't be signed is `500 server_error`.

### `invalid_grant_description`

**The wire doesn't say which check refused a code.** Wrong client, wrong `redirect_uri`, expired, wrong verifier and already redeemed all read "Invalid authorization grant", since telling them apart would leak facts about a code that may be another client's. The reason carries no secret, so it is logged, and the operator can still tell them apart.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs invalid_grant_description}}

### `ClientAuthenticationFailure`

The domain's [`ClientAuthenticationError`](<../../Authority/Authenticated Client Explanation.md>) and how the client presented its credentials.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs ClientAuthenticationFailure}}

#### `into_response`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs ClientAuthenticationFailure::into_response}}

## `http::routes::oauth::token_exchange`

### `TokenPayload`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs TokenPayload tests="tests::token_payload_tolerates_unparsed_client_credential_fields"}}

### `handle_token_request`

Each exchange goes to the [token exchanger](<../../Capabilities/OAuth/Token Exchanger Explanation.md>), with the authenticated client.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs handle_token_request}}

### `token_response`

It renders as a [`TokenResponse`](<../Errors and Wire Shapes Explanation.md#item-TokenResponse>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_exchange/mod.rs token_response}}

## `http::routes::oauth::token_revocation`

### `TokenRevocationPayload`

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs TokenRevocationPayload}}

### `handle_token_revocation_request`

**A client learns nothing about tokens that aren't its own.** The [client token revoker](<../../Capabilities/OAuth/Client Token Revoker Explanation.md>) tells the token's type from the token, ending a refresh token's family or denylisting an access token, and only when it is the authenticated client's.

{{#item apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/token_revocation.rs handle_token_revocation_request}}
