# Signing Keys

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs}}

The `signing_keys` table holds the RSA keys the server signs its tokens with, one row per [signing key](<../Domain/Signing Key Explanation.md>). The **active** key signs new tokens; every key in the table is published in the JWKS, so a token signed by a key that is no longer active still verifies.

| Column        | What it holds                                                       |
| ------------- | ------------------------------------------------------------------- |
| `kid`         | The primary key, and the `kid` header of every token the key signs. |
| `kty`, `alg`  | `RSA` and `RS256` for every key the server generates.               |
| `values_json` | The RSA components, public and private, as one JSON object.         |
| `is_active`   | Whether the key signs new tokens.                                   |

**Nothing in the table limits it to one active key.** Boot-time [seeding](<../Assembly/Seeding Explanation.md#open_and_seed_store>) inserts an active key only when it finds none, and nothing else writes the table, so there is at most one.

The [`SigningKey`](<../Domain/Signing Key Explanation.md#signingkey>) domain type is the row: it derives diesel's mappings onto the file's `table!`, its `values` field mapped to `values_json` through `JsonSigningKeyValues`, a [`json_text_column`](<../Persistence Explanation.md#json_text_column>).

## Test fixtures

The table treats a key's components as opaque JSON, so the round-trip property draws arbitrary base64url-shaped strings for them rather than real RSA material, and either value of `is_active`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs tests::arb_signing_key}}

## `insert_signing_key`

Writes a key. Seeding is its one caller outside tests. A second key with the same `kid` fails on the primary key. Port: [`insert_signing_key`](<../Grant Store/Signing Keys Explanation.md#insert_signing_key>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::insert_signing_key}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs tests::insert_and_fetch_round_trip}}

For any generated key, a fresh store holds exactly that key after the insert, read back unchanged, and `active_signing_key` returns it exactly when it is active.

## `all_signing_keys`

Every key, active first, then by `kid`. The JWKS publishes them, and verifying a token checks its signature against them. Port: [`all_signing_keys`](<../Grant Store/Signing Keys Explanation.md#all_signing_keys>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::all_signing_keys}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs tests::corrupt_values_json_is_a_typed_read_error}}

A key whose `values_json` is tampered to text that isn't JSON makes the read fail, rather than decode to garbage key material or panic.

## `active_signing_key`

The key that signs new tokens, private components included, or `None` when none is active. The access-token minter loads it inside the scope that mints; seeding asks it to decide whether to insert one. Port: [`active_signing_key`](<../Grant Store/Signing Keys Explanation.md#active_signing_key>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::active_signing_key}}

No unit test of its own; [`insert_and_fetch_round_trip`](#insert_signing_key) checks it against the `is_active` flag.

## `has_active_signing_key`

Whether a key is active, as an `EXISTS` query that loads no key material. Starting or continuing an authorization-code request asks it first, and refuses with `NoActiveSigningKey` when none is, rather than park a request the server could never mint tokens for. Port: [`has_active_signing_key`](<../Grant Store/Signing Keys Explanation.md#has_active_signing_key>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/signing_keys.rs SqliteGrantTx::has_active_signing_key}}

No unit test of its own.
