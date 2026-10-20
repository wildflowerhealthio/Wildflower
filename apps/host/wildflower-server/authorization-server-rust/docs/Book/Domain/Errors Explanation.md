# Errors

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authorize_refusal.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs}}

The server says no in four vocabularies, one per audience:

- [`AuthorizationServerError`](#item-AuthorizationServerError) to the Owner's UI on the `/authorization` surface, and from every operation when the store fails;
- [`OAuthErrorCode`](#item-OAuthErrorCode) to an app, as the `error` of an OAuth response;
- [`AuthorizeRefusal`](#item-AuthorizeRefusal) to the person at the browser, or the app, when `/oauth/authorize` refuses a request;
- [`TokenExchangeError`](#item-TokenExchangeError) to an app at `/oauth/token`, with the specific reason kept for the operator's log.

**None of them knows about HTTP.** Each is a domain fact, and the HTTP layer decides the status and the body ([Errors and Wire Shapes](<../HTTP/Errors and Wire Shapes Explanation.md>)). The two that reach an app are built so that nothing from the request is echoed back: a code is one of a closed set, and a description is one of the server's fixed sentences.

## `domain::authorization_server_error`

### `AuthorizationServerError`

The semantic variants are decided one layer up from the store, in the capabilities, so the SQLite adapter and the in-memory test fake speak only the port's primitive contract, and the store produces nothing but `Infrastructure`. `Display` gives each variant a sentence for the logs.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError}}

#### `infrastructure`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError::infrastructure}}

#### From `MissingScopes`

The scope gate's own rejection becomes `InsufficientScope`, so it reaches the wire through the same rendering as any other failure.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorization_server_error.rs AuthorizationServerError::from}}

## `domain::oauth_error_code`

### `OAuthErrorCode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/oauth_error_code.rs OAuthErrorCode tests="tests::as_ref_matches_rfc_wire_values tests::display_matches_as_ref"}}

## `domain::authorize_refusal`

RFC 6749 §4.1.2.1 lets a refusal go back to the app only once its `redirect_uri` is trusted. Before that point, or for a redirect nobody has vouched for, the refusal is a local page in the browser. Either way the reason is the same sentence.

### `AuthorizeRefusal`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorize_refusal.rs AuthorizeRefusal}}

#### `description`

**Every sentence is a fixed string, never request input, and valid `error_description` text**, so nothing an attacker sends is echoed back and no sentence breaks the redirect's grammar. The tests check every sentence against the RFC's grammar with a [small predicate](<Test Fixtures Explanation.md#errors>), including the three fixed sentences of the [client callback](<Authorization Code Explanation.md#domainclient_redirect>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authorize_refusal.rs AuthorizeRefusal::description tests="tests::every_description_is_a_valid_error_description tests::a_quote_backslash_or_non_ascii_is_not_an_error_description"}}

## `domain::token_exchange_error`

**The app hears less than the log.** The HTTP layer collapses the specific reasons a grant was refused onto a few generic descriptions ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/oauth/internal.rs invalid_grant_description}}), so a response doesn't say which check a code failed, and a refresh token presented by the wrong app reads exactly like an unknown one. Two reasons record what was done as well as what was found: a code that is unknown or already redeemed has revoked any refresh family minted from it, and a consumed refresh token presented again has revoked its whole family.

The [token exchanger](<../Capabilities/OAuth/Token Exchanger Explanation.md>) and the [redemption proofs](<../Authority/Redemption Explanation.md>) raise each variant, and their tests show them.

### `InvalidGrantReason`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs InvalidGrantReason}}

### `TokenExchangeError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/token_exchange_error.rs TokenExchangeError}}
