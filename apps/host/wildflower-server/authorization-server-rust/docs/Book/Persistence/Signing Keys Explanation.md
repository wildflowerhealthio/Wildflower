# Signing Keys

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs}}

The `signing_keys` table holds the RSA keys the server signs its tokens with, one row per [signing key](<../Domain/Signing Key Explanation.md>), keyed by `kid`, the `kid` header of every token the key signs. The [`SigningKey`](<../Domain/Signing Key Explanation.md#item-SigningKey>) domain type is the row, its `values` mapped to `values_json` through `JsonSigningKeyValues`, a [`json_text_column`](<../Persistence Explanation.md#item-json_text_column>). The **active** key signs new tokens; every key in the table is published, so a token signed by a key no longer active still verifies.

**Nothing in the table limits it to one active key.** Boot-time [seeding](<../Assembly/Seeding Explanation.md>) inserts an active key only when it finds none, and nothing else writes the table, so there is at most one.

The round-trip property draws keys from [`arb_signing_key`](<Test Fixtures Explanation.md#item-tests--arb_signing_key>).

## `db::signing_keys`

### `impl SigningKeysTx for SqliteGrantTx`

The port is [`SigningKeysTx`](<../Grant Store/Signing Keys Explanation.md#item-SigningKeysTx>).

#### `insert_signing_key`

Seeding is its one caller outside tests. A second key with the same `kid` fails on the primary key.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::insert_signing_key tests="tests::insert_and_fetch_round_trip"}}

#### `all_signing_keys`

The published key set, and what verifying a token checks its signature against.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::all_signing_keys tests="tests::corrupt_values_json_is_a_typed_read_error"}}

#### `active_signing_key`

The access token minter loads it inside the scope that mints; seeding asks it to decide whether to insert one.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::active_signing_key}}

#### `has_active_signing_key`

Starting or continuing a code request asks it first, and refuses when none is, rather than park a request the server could never mint tokens for.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::has_active_signing_key}}
