# Test Fake

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs}}

Every unit test in `src/domain/` runs against `FakeGrantStore`: the [grant store port](<../Grant Store Explanation.md>) kept in memory, one map per table, with no diesel and no database. It exists so a test of a rule (a code redeems once, a decision lands once, a revoked session fails closed) reads as the rule, and runs in microseconds. **It models the guarantees the domain relies on, not the SQL**: each primitive does what its port promises, in plain Rust over the maps. The SQL that keeps the same promises, with real locks and real constraints, is tested in the [Persistence](<../Persistence Explanation.md>) part.

This page is also the appendix of the fixtures the crate's unit tests share, the second half below.

## `domain::test_fake`

### `FakeGrantStore`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore}}

#### The scopes

**A write scope rolls back on `Err`, as SQLite's would**: it snapshots every map before running the closure and restores them when the closure fails, so a test never sees half of a failed operation. That is the one property of a write scope the fake models. It takes no lock, as the fake is single-threaded, so a race is tested by ordering: read a request, move it with another transition, then write the first.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::write}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::read}}

#### `tx`

It writes straight through, with no rollback.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::tx}}

### `FakeTables`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeTables}}

### `FakeGrantTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantTx}}

## `domain::test_fake::tx`

Every primitive is implemented on [`FakeGrantTx`](#item-FakeGrantTx), one `impl` per table trait. Those a domain rule rests on are written to the promise the port makes.

### A decision lands once

A replace writes only while the stored request still has the status the transition read it with ([the guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::replace_code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::replace_user_code_request}}

### A code redeems once

Removing it from the map hands the row to the first caller and `None` to every later one.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::redeem_authorization_code}}

### A launch is spent once, by its own app

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::consume_launch_context}}

### A refresh token is consumed once

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::stamp_refresh_token_consumed_if_live}}

### A missing session counts as revoked

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::is_browser_session_revoked}}

### The Owner is asked about the newest request still waiting

A disabled app's request is skipped, and an app with no registration is kept with no registered name, as the SQL's left join to `clients` does.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::owner_prompt}}

### A session outlives its end while a live family names it

Its limited-page acknowledgements go with it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::delete_browser_sessions_ended_before}}

### Where the fake is looser than SQLite

The fake leaves out what no domain rule rests on, so a test can't lean on these:

- **No unique constraints.** An insert of a repeated key (a `sid`, a code, a second pending request with the same `user_code`) overwrites the old entry instead of failing, and the signing-key insert appends.
- **Updates insert.** `update_authorization_code_grant` and `update_device_grant` write the grant whether or not it was there.
- **Orderings differ.** `all_grants` sorts by grant id, where SQLite orders by `granted_at`; `all_signing_keys` keeps insertion order, where SQLite puts the active key first, then orders by `kid`.
- **No locks.** Concurrency is tested in SQLite; the fake only sequences.

## `domain::test_fake::fixtures`

The request fixtures are made by the entities' own constructors and transitions, so a fixture in any status is one the domain could have reached.

### Requests

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_request_for}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs fixture_code_args}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_with_status}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs device_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs device_with_status}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs fixture_approval}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs pairing_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs approve_stored}}

### The browser session

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs FIXTURE_SID}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs seed_fixture_browser_session}}

### Clients, grants and keys

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs owned_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs authenticated_public_client}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_grant}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs seed_active_signing_key}}

### Proofs

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs redeemed_code}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs delegated_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs registering_delegated_scopes}}

### Doubles for the host's ports

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs RecordingOwnerApproval}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs RecordingOwnerApproval::count}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs NothingRevoked}}
