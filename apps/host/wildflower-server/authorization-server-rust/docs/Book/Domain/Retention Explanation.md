# Retention

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs}}

Why the server deletes rows on a timer, why the windows are 90 days, 7 days and a day, and why they are measured past each row's expiry rather than from now.

## Tables that only grow

Most of the server's tables limit themselves: a grant is deleted when it is revoked, and an authorization code when it is redeemed. These don't:

- **`refresh_token_families` and `refresh_tokens`.** Rotation adds a link per generation, and ending a [family](<Refresh Token Explanation.md>) deliberately deletes nothing: it pulls the family's deadline back and spends its live link. Keeping the rows is what lets a replayed link still resolve to its dead family, which is how reuse detection knows to end a lineage rather than shrug at an unknown hash.
- **`code_authorization_requests` and `user_code_requests`.** Nothing moves a request the person simply walked away from. It stays pending, and expired, for good.
- **`authorization_codes`.** Redemption deletes a code, so only the codes nobody came back for pile up.
- **`browser_sessions`.** Every sign-in and pairing adds a row, and revoking a [session](<Browser Session Explanation.md>) stamps it rather than deleting it, so the tokens it minted can still be refused by its `sid`.

None of this is a correctness problem: every read already checks expiry, so a stale row is inert. It is a storage problem, and on a single-user desktop app the storage is the Owner's disk.

## A window past expiry, not now

The plain sweep would be "delete where `expires_at` is before now". It reclaims the most, and it is the wrong tool, because these rows have audit value after they stop being usable. "Why did that device lose access on Tuesday?" is answerable only while Tuesday's lineage is still there. A cutoff at now destroys the record at the moment it stops being state and becomes evidence.

So **each window is measured past the row's own expiry**: the retention clock starts when the row stopped being usable, not when it was made. For a browser session that is its expiry or its revocation, whichever came first. Two things follow:

- **Nothing live is ever in range.** A live family's deadline is in the future, and a cutoff of now less 90 days is behind now. The sweep can't delete something in use even with every window set to zero.
- **A revoked family gets its full window too.** Ending a family pulls its deadline back to the moment it ended, so the clock starts there. The reuse-detection case, the one most worth auditing, is kept 90 days from the event.

A family is deleted with every link in it, links first, since every pooled connection enforces foreign keys. Leaving orphaned links would be worse than keeping everything: an orphan reads as an unknown token, which is exactly the answer that makes replay detection do nothing.

## When the sweep runs

{{#code-link apps/host/wildflower-server/authorization-server-rust/src/lib.rs spawn_retention_sweep}} sweeps once at startup and then daily. The desktop app has no cron and shouldn't need one. Daily is far finer than the coarsest window, so no row outstays its policy by much, and a machine switched off for a month sweeps once on its next boot rather than catching up a month of missed ticks. The deletes run in one write scope, so a failure rolls back to the set before the sweep; the failure is logged, and the next tick tries again. A sweep is logged only when it reclaimed something.

## The insert's narrow prune

One delete happens outside the sweep. A device request or pairing is keyed for the Owner by its `user_code`, and a partial unique index holds at most one pending request per `user_code`. An expired request still pending under a `user_code` occupies that index until the sweep reaches it, so inserting a new request under the same code would fail. The insert ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::insert_user_code_row}}) therefore first clears exactly that: rows holding this request's `user_code` that are still pending and had already expired when this request started. The condition mirrors the index. A decided row is left for the sweep, since it isn't in the index and could never collide, and a live pending one is never dropped to make room: that collision stays an error.

It is a guard on the index, not a step the flow relies on. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/device_authorizer.rs generate_unique_user_code}} already draws a code no request of any status holds.

## `domain::retention`

The tests place rows either side of each window around one [fixed instant](<Test Fixtures Explanation.md#retention>), in the in-memory test fake.

### `REFRESH_TOKEN_FAMILY_RETENTION`

A family that runs its full course is readable for twice its lifetime: a quarter's history, the horizon over which "what happened to this device's session" is still a live question.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs REFRESH_TOKEN_FAMILY_RETENTION}}

### `AUTHORIZATION_RETENTION`

Requests live five minutes and codes one: a week is long enough to answer "what did that app try to do last Tuesday", and short enough that abandoned flows can't pile up.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs AUTHORIZATION_RETENTION}}

### `BROWSER_SESSION_RETENTION`

A session's limited-page acknowledgements go with it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs BROWSER_SESSION_RETENTION}}

### `PurgedCounts`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs PurgedCounts}}

#### `is_empty`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs PurgedCounts::is_empty tests="tests::a_second_pass_reclaims_nothing"}}

### `purge_expired`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/retention.rs purge_expired tests="tests::purges_past_each_window_and_spares_everything_inside_it tests::deleting_a_family_takes_its_tokens tests::an_empty_database_reclaims_nothing tests::the_spared_rows_are_reclaimed_once_they_age_out"}}
