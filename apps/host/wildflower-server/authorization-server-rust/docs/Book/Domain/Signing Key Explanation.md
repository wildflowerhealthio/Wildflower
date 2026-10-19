# Signing Key

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs}}

Every access token the server issues is a JWT signed with an RSA key the server holds, and every token presented back is checked against those keys. A signing key is that key at rest: one row, with its private half, in the server's own database. **The server signs with its one active key and verifies against every key it holds.** It publishes the public half of every key at its JWKS endpoint, so anything else that checks its tokens can do the same.

The server makes its key itself. On a boot that finds no active key, it generates one and stores it as active ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/seeding.rs ensure_some_active_signing_key}}); on every later boot it leaves the keys alone.

## `SigningKey`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs SigningKey}}

| Field        | The fact it records                                                                          |
| ------------ | -------------------------------------------------------------------------------------------- |
| `kid`        | A random id, written into each token's header so a verifier can pick the key that signed it. |
| `kty`, `alg` | `RSA` and `RS256` for every key the server makes.                                            |
| `values`     | The key itself, public and private parts.                                                    |
| `is_active`  | Whether this key signs new tokens. A key that isn't active still verifies.                   |

## `SigningKeyValues`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs SigningKeyValues}}

The RSA components as base64url strings: the public `n` and `e`, and the private `d`, `p` and `q`. The value scrubs its memory when dropped.

**Private parts never print.** A key formatted into a log line or a panic shows its public parts, so it stays identifiable, and `<redacted>` in place of the private ones:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs SigningKeyValues::fmt}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs tests::debug_redacts_private_exponents}}

None of the three private strings appears in the formatted value, the redaction marker does, and both public strings do.

## `generate`

A fresh 2048-bit key with a new `kid`, not yet active; whoever stores it decides whether it signs.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs SigningKey::generate}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs SigningKey::from}}

No unit test of its own; the round trip below starts from a generated key.

## Signing and verifying

A stored key becomes the `jsonwebtoken` key that signs, from the whole RSA key, and the one that verifies, from the public half alone:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs EncodingKey::try_from}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs DecodingKey::try_from}}

Each goes through the `rsa` key rebuilt from the stored components, {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs RsaPrivateKey::try_from}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs RsaPublicKey::try_from}}.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs tests::round_trip_sign_verify}}

A token signed with a generated key's signing half verifies with its verifying half, and every claim comes back as it went in.

## Publishing

The JWKS endpoint lists each key as a public JWK: its `kid`, `n` and `e`, marked for verifying only.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs PublicJwk::from}}

No unit test of its own.

## `KeyMaterialError`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/signing_key.rs KeyMaterialError}}

What can go wrong turning stored key material into a working key: a component that isn't base64url, components that don't make an RSA key, a DER encoding failure, or key generation failing. Each keeps its source error. A key that fails here is the operator's problem, not the caller's: minting and verifying report it as an unreadable signing key ([Token](<Token Explanation.md#minterror>)).
