# Access Token

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/claims.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/verify.rs}}

An access token is what an app shows the FHIR server to be let in. It is a JWT the server signs with its active [signing key](<Signing Key Explanation.md>), and it states everything the server decided: which app it was issued to, the scopes it carries, the SMART patient, and the [browser session](<Browser Session Explanation.md>) it was earned under. **Whoever holds the token has that access until it expires or is revoked**, so it is short-lived, and each one carries an id of its own so it can be revoked alone.

This page is the token as a value: its claims, minting one, and checking a presented one's signature and claims. Revocation is checked on top of that, by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify}}: a token whose `jti` is denylisted, whose app's revocation epoch post-dates it, or whose browser session is revoked is refused even though its signature is good. Three claims are there for revocation's sake, one per way to revoke: the `jti` names one token, the `sub` and `iat` place it before or after its app was revoked, and the `sid` names the browser it was earned in.

## `domain::access_token`

### `ACCESS_TOKEN_TTL`

The lifetime of a token issued at `/oauth/token`. A paired browser's token and the Owner's sign-in token are minted with lifetimes of their own.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mod.rs ACCESS_TOKEN_TTL}}

## `domain::access_token::claims`

### `AccessTokenClaims`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/claims.rs AccessTokenClaims}}

### `VerifiedClaims`

Read back leniently: every claim but the issuer, the subject and the audience is optional.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/claims.rs VerifiedClaims}}

#### `granted`

**The scopes a token carries are its authority.** The scope-gated routes read them through the one shared claim parser, so every gate that reads a `scope` claim agrees on what it grants, and a token with no `scope` claim grants nothing.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/claims.rs VerifiedClaims::granted}}

### `deserialize_audience`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/claims.rs deserialize_audience}}

## `domain::access_token::mint`

The tests sign with one [shared key](<Test Fixtures Explanation.md#access-token>), since generating an RSA key per case is slow.

### `NewAccessTokenArgs`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs NewAccessTokenArgs}}

### `mint_access_token`

The `jti` and the times are the mint's own, never the caller's, so no mint site can forget them or reuse an id. The server's own minter, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::mint}}, sets the issuer and audience to the server's origin.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs mint_access_token tests="tests::mint_and_verify_round_trip tests::each_mint_carries_a_unique_jti"}}

### `AccessTokenMintError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs AccessTokenMintError}}

### `AccessTokenIssuanceError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/mint.rs AccessTokenIssuanceError}}

## `domain::access_token::verify`

### `AccessTokenVerifyOptions`

The server passes its own origin as the issuer and the one accepted audience.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/verify.rs AccessTokenVerifyOptions}}

### `verify_access_token`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/verify.rs verify_access_token tests="tests::verify_rejects_wrong_issuer tests::verify_rejects_empty_token tests::verify_rejects_when_no_keys tests::verify_accepts_legacy_token_without_jti"}}

### `AccessTokenVerifyError`

The answers split by whose fault they are. A bad token and a revoked one are the caller's, a `401`, kept distinct so the logs can tell them apart. Everything else is the server's, a `500`, and **a store that can't say whether a token is revoked refuses it**. `verify_access_token` itself answers only `TokenRejected`, `NoSigningKeysConfigured` and `SigningKeyUnreadable`; the rest come from the revocation checks in `TokenVerifier`.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/verify.rs AccessTokenVerifyError}}
