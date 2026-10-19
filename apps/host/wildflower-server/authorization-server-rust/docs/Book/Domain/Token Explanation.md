# Token

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs}}

An access token is what an app shows the FHIR server to be let in. It is a JWT the server signs with its active [signing key](<Signing Key Explanation.md>), and it states everything the server decided: which app it was issued to, the scopes it carries, the SMART patient, and the browser session it was earned under. **Whoever holds the token has that access until it expires or is revoked**, so it is short-lived, and each one carries an id of its own so it can be revoked alone.

This page is the token as a value: its claims, minting one, and checking a presented one's signature and claims. Revocation is checked on top of that, by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify}}: a token whose `jti` is denylisted, whose app's revocation epoch post-dates it, or whose browser session is revoked is refused even though its signature is good.

## `AccessTokenClaims`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs AccessTokenClaims}}

| Claim        | The fact it records                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `iss`, `aud` | The server's origin, both. A token minted by another server is refused.                                              |
| `sub`        | The app the token was issued to, by `client_id`.                                                                     |
| `jti`        | A random id, fresh on every mint. **Revoking one token** denylists this id.                                          |
| `exp`, `iat` | When the token stops working, and when it was minted. Revoking an app refuses every token minted before that moment. |
| `scope`      | The scopes, space-separated.                                                                                         |
| `patient`    | The SMART patient, when the approval named one.                                                                      |
| `sid`        | The browser session the token was earned under, when there was one. Revoking that browser revokes the token.         |

## `ACCESS_TOKEN_TTL`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs ACCESS_TOKEN_TTL}}

How long a token issued at `/oauth/token` works. The consent card's `offline_access` line ("Access your data after 15 minutes") states the same number. A paired browser's token and the Owner's sign-in token are minted with lifetimes of their own. No unit test of its own.

## `NewJwtArgs`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs NewJwtArgs}}

What the caller decides about a token. The audience falls back to the issuer; the server's own minter ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::mint}}) sets both to the server's origin.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs shared_key}}

One generated key shared by the property tests, since generating an RSA key per case is slow.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs owner_args}}

The least a token can say: an app and an origin, no scopes, no patient, no session.

## `mint_access_token`

Signing a token from the caller's choices. The `jti` and the times are the mint's own, never the caller's, so no mint site can forget them or reuse an id. The header names the signing key's `kid`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs mint_access_token}}

### What it looks like

[`each_mint_carries_a_unique_jti`](../../../src/domain/token/tests.rs), a property test (in a `proptest!` block, so linked rather than shown): minting the same inputs over and over yields a different, non-empty `jti` every time, so two live tokens never share a revocation handle.

## `MintError`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs MintError}}

Minting fails only if the key's material can't be loaded or the JWT can't be encoded. No unit test of its own.

## `TokenIssuanceError`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs TokenIssuanceError}}

What issuing a token can fail with, as the capabilities see it: no active key to sign with (the server's setup is broken), a signing failure, or a store failure while reading the key. No unit test of its own.

## `VerifiedClaims`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs VerifiedClaims}}

The claims of a presented token whose signature, issuer, audience and expiry have checked out. They are read leniently: an audience may arrive as one string or a list, and becomes a list either way.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs deserialize_audience}}

**The scopes a token carries are its authority.** The scope-gated routes read them through the one shared claim parser, so every gate that reads a `scope` claim agrees on what it grants. A token with no `scope` claim grants nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs VerifiedClaims::granted}}

Most claims are optional when read. A token with no `jti` still verifies; only per-token revocation can't name it, and revoking its app or its session still reaches it.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs verify_accepts_legacy_token_without_jti}}

A token signed by hand with every claim but `jti` verifies, and reads back with no `jti` and the right subject.

## `VerifyOptions`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs VerifyOptions}}

The issuer a token must name, and the audiences it may name. The server passes its own origin for both.

## `verify_jwt`

Checking a presented token against the keys the server holds. When the token's header names a `kid` the server has, only that key is tried; otherwise every key is. The token must be RS256, from the expected issuer, for an accepted audience, and unexpired.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs verify_jwt}}

### What it looks like

[`mint_and_verify_round_trip`](../../../src/domain/token/tests.rs), the other property test in that file: across generated apps, scopes, lifetimes, origins, audiences, patients and sessions, a minted token verifies to exactly the claims it was minted with, with `exp - iat` equal to the lifetime and `iat` within two seconds of the mint.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs verify_rejects_wrong_issuer}}

A token from one issuer is rejected by a verifier expecting another.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs verify_rejects_empty_token}}

An empty token is rejected.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token/tests.rs verify_rejects_when_no_keys}}

With no keys to check against, verification reports the server's misconfiguration rather than blaming the token.

## `VerifyError`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/token.rs VerifyError}}

The answers split by whose fault they are. A bad token (`TokenRejected`) or a revoked one (`Revoked`) is the caller's, a `401`; the two stay distinct so the logs can tell them apart. Everything else is the server's: no keys, an unreadable key, or a store that couldn't be read. Those are a `500`, and **a store that can't say whether a token is revoked refuses it**. `verify_jwt` itself returns only `TokenRejected`, `NoSigningKeysConfigured` and `SigningKeyUnreadable`; the rest come from the revocation checks in `TokenVerifier`.
