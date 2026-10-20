# Signing Keys

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs}}

The `signing_keys` table holds the server's [signing keys](<../Domain/Signing Key Explanation.md>), one row per key, keyed by `kid`. **The active key signs every new token; every key in the table is published and verified against**, so a token signed by a key since rotated out still checks. Boot-time [seeding](<../Assembly/Seeding Explanation.md>) makes sure an active key exists, and nothing else in the server writes one.

The [access token minter](<../Writers/Access Token Minter Explanation.md>) loads the active key inside the scope that mints, and with none it refuses. `/oauth/authorize` asks only whether one exists, before starting or continuing a code request: **a server that couldn't sign the token at the end doesn't start the flow**.

## `domain::grant_store::signing_keys`

### `SigningKeysTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/signing_keys.rs SigningKeysTx}}
