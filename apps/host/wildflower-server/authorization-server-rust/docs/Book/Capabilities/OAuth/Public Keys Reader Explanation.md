# Public Keys Reader

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs}}

Every token this server mints is signed with one of its [signing keys](<../../Domain/Signing Key Explanation.md>). Anyone checking a token (the FHIR server, an app) needs the public half of that key. The public keys reader is the read behind `GET /.well-known/jwks.json`, the server's JSON Web Key Set.

**It is public, and its one power is this read.** It hands out public JWKs only: the private material stays inside the signing key it is projected from.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader}}

`new` builds it over a store handle; the live binding builds it over the SQLite store.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader::new}}

## `public_jwks`

**Every stored key is published, the active one and those rotated out alike.** A key rotated out signs nothing new, but it stays in the set, so a token it signed can still be checked. Each key becomes a public JWK through the signing key's [publishing](<../../Domain/Signing Key Explanation.md#publishing>) projection. The read runs in a read scope ([`all_signing_keys`](<../../Grant Store/Signing Keys Explanation.md#all_signing_keys>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/public_keys_reader.rs PublicKeysReader::public_jwks}}

No unit test of its own. Exercised end to end by [`jwks_endpoint_returns_seeded_key`](<../../Integration Tests/Smoke Explanation.md#jwks_endpoint_returns_seeded_key>), through the route's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/http/routes/well_known_jwks.rs handle_jwks_request}}.
