# Public Keys Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs}}

Every token this server mints is signed with one of its [signing keys](<../../Domain/Signing Key Explanation.md>). Anyone checking a token, the FHIR server or an app, needs the public half of that key. The public keys reader is the read behind `GET /.well-known/jwks.json`, the server's JSON Web Key Set. **It is public, and its one power is this read.** It hands out [public JWKs](<../../Domain/Signing Key Explanation.md#into-a-public-jwk>) only: the private material stays inside the signing key they are projected from.

A key rotated out signs nothing new, but it stays in the set, so a token it signed can still be checked.

## `domain::capabilities::oauth::public_keys_reader`

### `PublicKeysReader`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader::new}}

#### `public_jwks`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader::public_jwks}}
