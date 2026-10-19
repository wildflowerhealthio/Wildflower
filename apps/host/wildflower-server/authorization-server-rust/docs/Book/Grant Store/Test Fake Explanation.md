# Test Fake

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs}}

Every unit test in `src/domain/` runs against `FakeGrantStore`: the [grant store port](<../Grant Store Explanation.md>) kept in memory, one map per table, with no diesel and no database. It exists so a test of a rule (a code redeems once, a decision lands once, a revoked session fails closed) reads as the rule, and runs in microseconds. **It models the guarantees the domain relies on, not the SQL**: each primitive does what its port section promises, in plain Rust over the maps. The SQL that keeps the same promises, with real locks and real constraints, is tested in the [Persistence](<../Persistence Explanation.md>) part.

The second half of this page is the fixtures the domain tests share: requests in each status, a registered client, a seeded signing key, a redeemed code, and two small doubles for the host's ports.

## `FakeGrantStore`

The store. Cloning it shares the tables, so a test hands one clone to the capability under test and arranges and inspects rows through another.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore}}

## `FakeTables`

One map per table, plus the set of (`sid`, `client_id`) pairs that have gone past the limited page. Each sits in a `RefCell`, so a primitive taking `&mut self` mutates through a shared borrow.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeTables}}

## `FakeGrantTx`

What a scope lends: a borrow of the tables. Every primitive in `tx.rs` is implemented on it, one `impl` per table trait, so it is a `GrantTx`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantTx}}

## The scopes

**A write scope rolls back on `Err`, as SQLite's would.** It snapshots every map before running the closure and restores them when the closure fails, so a test never sees half of a failed operation. That is the one property of a write scope the fake models. It takes no lock (the fake is single-threaded), so a race is tested by ordering: read a request, move it with another transition, then write the first.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::write}}

A read scope runs the closure on the tables as they are.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::read}}

## `tx`

A handle on the tables outside any scope, for a test to plant rows before the act and inspect them after. It writes straight through, with no rollback.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/mod.rs FakeGrantStore::tx}}

## How the fake keeps the port's promises

The primitives a rule rests on are written to the promise their port section makes. The guarded ones:

**A decision lands once.** The replace writes only when the stored request is still in the phase the transition read it in ([`replace_authorization_request`](<Authorization Requests Explanation.md#replace_authorization_request>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::replace_authorization_request}}

**A code redeems once**: removing it from the map hands the row to the first caller and `None` to every later one ([`redeem_authorization_code`](<Authorization Codes Explanation.md#redeem_authorization_code>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::redeem_authorization_code}}

**A launch is spent once, by its own app** ([`consume_launch_context`](<Launch Contexts Explanation.md#consume_launch_context>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::consume_launch_context}}

**A refresh token is consumed once** ([`stamp_refresh_token_consumed_if_live`](<Refresh Tokens Explanation.md#stamp_refresh_token_consumed_if_live>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::stamp_refresh_token_consumed_if_live}}

**A missing session counts as revoked** ([`browser_session_is_revoked`](<Browser Sessions Explanation.md#browser_session_is_revoked>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::browser_session_is_revoked}}

**The host is asked about the newest request still waiting, skipping a disabled app's**, mirroring the SQL's left join to `clients` ([`newest_pending_consent`](<Authorization Requests Explanation.md#newest_pending_consent>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::newest_pending_consent}}

**A session outlives its end while a live family names it**, and its limited-page acknowledgements go with it ([`delete_browser_sessions_ended_before`](<Browser Sessions Explanation.md#delete_browser_sessions_ended_before>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/tx.rs FakeGrantTx::delete_browser_sessions_ended_before}}

## Where the fake is looser than SQLite

The fake leaves out what no domain rule rests on, so a test can't lean on these:

- **No unique constraints.** An insert of a repeated key (a `sid`, a `kid`, a code, a second pending request with the same `user_code`) overwrites the old entry instead of failing, and the signing-key insert appends.
- **Updates insert.** `update_authorization_code_grant` and `update_device_grant` write the grant whether or not it was there.
- **Orderings differ.** `all_grants` sorts by grant id, where SQLite orders by `granted_at`; `all_signing_keys` keeps insertion order, where SQLite puts the active key first, then orders by `kid`.
- **No locks.** Concurrency is tested in SQLite; the fake only sequences.

## `pending_request`

The request fixtures are made by the entity's own constructor and transitions, so a fixture in any status is one the domain could have reached. `pending_request` starts a request from the client `client`, now, asking for `scopes`, of any kind, expiring at `expires_at`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs pending_request}}

## `with_status`

Move a pending request to `status` through its own transitions, a millisecond before it expires: an approval grants exactly what was asked, and `Claimed` is approved then claimed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs with_status}}

It approves through the transition that matches the request's kind.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs approve_as_its_kind}}

## `device_request`

A device-flow request with `user_code`, asking for `openid`, live for five minutes, then moved to `status`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs device_request}}

## `FIXTURE_SID`

The browser session every code-flow fixture is made in. It names no session until [`seed_fixture_browser_session`](#seed_fixture_browser_session) starts one, so a test that doesn't seed it sees the session as revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs FIXTURE_SID}}

## `seed_fixture_browser_session`

Start `FIXTURE_SID` as a standing paired-browser session holding `wildflower/launch`, for a day, so a fixture request can be approved and the code and family it earns are honoured.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs seed_fixture_browser_session}}

## `fixture_code`

What a code request fixture carries: the `https://example.com/cb` redirect, a PKCE challenge, the client `state`, and `FIXTURE_SID`. It has no launch, is already past its limited page, and is not decidable in the requesting browser, so it goes straight to the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs fixture_code}}

## `code_request`

A code request from `client` asking for `read`, expiring at `expires_at`, moved to `status`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_request}}

## `code_request_for`

A pending code request from a chosen client for chosen scopes, live for five minutes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_request_for}}

## `approve_stored`

Approve a request already in the store, now, as the consent surfaces would: grant `granted_scopes`, optionally name the device or browser, and write it through the guarded replace, asserting it landed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs approve_stored}}

## `owned_scopes`

Owned scope strings from literals.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs owned_scopes}}

## `client`

A public client trusted on first use, named `<client_id> display name`, allowed every grant type, registered for the one redirect the request fixtures use, with the scopes the test passes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs client}}

## `authenticated_public_client`

Register a public client and authenticate as it through the real [`AuthenticatedClient`](<../Authority/Authenticated Client Explanation.md>) check, for a test that needs the proof.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs authenticated_public_client}}

## `code_grant`

A standing authorization-code grant for `read` at the fixture redirect.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs code_grant}}

## `delegated_scopes`

Scopes as an approver holding everything would delegate them to a device, nothing clamped away.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs delegated_scopes}}

## `registering_delegated_scopes`

The same for a code-flow client trusted on first use, so recording them also writes its registration.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs registering_delegated_scopes}}

## `seed_active_signing_key`

Generate a key, store it as the active one, and return it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs seed_active_signing_key}}

## `redeemed_code`

A code issued to a freshly registered public client for `granted_scopes`, bound to patient `pat-1` and the fixture redirect, under `FIXTURE_SID`, then redeemed through the real [`redeem`](<../Authority/Redemption Explanation.md#redeem>): for a test that needs the redemption proof, not the redemption rule. A standing grant the test planted for that client and redirect is picked up.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs redeemed_code}}

## `RecordingOwnerApproval`

An Owner-approval port that counts how often the newest pending consent is republished, so a test can assert a capability republished after its scope, or didn't.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs RecordingOwnerApproval}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs RecordingOwnerApproval::count}}

## `NothingRevoked`

A revocation check under which nothing is revoked: no denylisted token and no subject epoch.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs NothingRevoked}}
