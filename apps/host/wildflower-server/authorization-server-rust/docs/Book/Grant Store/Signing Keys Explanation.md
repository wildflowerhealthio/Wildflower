# Signing Keys

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs}}

The `signing_keys` table holds the server's [signing keys](<../Domain/Signing Key Explanation.md>): one row per key, keyed by `kid`. **The active key signs every new token; every key in the table is published and verified against.** Boot-time seeding makes sure an active key exists: it generates one only when a read finds none, before taking the write lock because generating an RSA key is slow, then checks again under the lock before inserting it. Nothing else in the server writes a key.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx}}

## `all_signing_keys`

Every key, the active one first, then by `kid`. This is the set a token is checked against: the server's published keys, the session-token verifier, and an app revoking an access token all verify with it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx::all_signing_keys}}

The SQLite side: [`all_signing_keys`](<../Persistence/Signing Keys Explanation.md#all_signing_keys>).

## `active_signing_key`

The key that signs, or `None` when none is active. The access token minter loads it inside the scope that mints, and with no active key it refuses to mint.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx::active_signing_key}}

The SQLite side: [`active_signing_key`](<../Persistence/Signing Keys Explanation.md#active_signing_key>).

## `has_active_signing_key`

Whether an active key exists, without loading its private key material. `/oauth/authorize` asks it before starting or continuing a code request: **a server that couldn't sign the token at the end doesn't start the flow**.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx::has_active_signing_key}}

The SQLite side: [`has_active_signing_key`](<../Persistence/Signing Keys Explanation.md#has_active_signing_key>).

## `insert_signing_key`

Record a key. A repeated `kid` fails the insert.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx::insert_signing_key}}

The SQLite side: [`insert_signing_key`](<../Persistence/Signing Keys Explanation.md#insert_signing_key>).
