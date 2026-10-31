# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs}}

Two tables hold what the server knows about the browsers it has let in. `browser_sessions` holds one row per [browser session](<../Domain/Browser Session Explanation.md>), keyed by its `sid`, read back as a [`BrowserSession`](<../Domain/Browser Session Explanation.md#item-BrowserSession>), one field to one column of the same name. `scopes` is compact JSON text through the shared `JsonStrings`; `kind` is its wire string, `same_device` or `paired`, which a `CHECK` on the column also enforces.

**A session's row outlives the session.** Revoking it stamps `revoked_at` and keeps the row, because the token verifier and a refresh look the `sid` up to refuse what the session minted. The row goes only in the retention sweep, [`purge_expired`](<../Domain/Retention Explanation.md#item-purge_expired>), with the cutoff `now` less [`BROWSER_SESSION_RETENTION`](<../Domain/Retention Explanation.md#item-BROWSER_SESSION_RETENTION>).

`session_shortfall_acknowledgements` records, per session, **the apps it has gone on past its [limited page](<../Domain/Authorization Request/Code Request Explanation.md>) for**. Its primary key is the pair (`sid`, `client_id`), so a pair is recorded at most once and a lookup by the pair is a key lookup. Neither table carries a foreign key: `sid` here, and on the requests, codes and refresh families that record it, is a soft reference the retention sweep keeps tidy.

The tests open a store with [`store`](<Test Fixtures Explanation.md#item-browser_sessions--tests--store>).

## `db::browser_sessions`

### `impl BrowserSessionsTx for SqliteGrantTx`

The port is [`BrowserSessionsTx`](<../Grant Store/Browser Sessions Explanation.md#item-BrowserSessionsTx>).

#### `insert_browser_session`

A second session with the same `sid` breaks the primary key. Every test here starts by inserting sessions.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::insert_browser_session}}

#### `browser_session_by_sid`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::browser_session_by_sid}}

#### `is_browser_session_revoked`

A missing session fails closed.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::is_browser_session_revoked}}

#### `revoke_browser_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::revoke_browser_session tests="tests::a_session_round_trips_and_is_revoked_once"}}

#### `live_browser_sessions`

The Owner's list of browsers.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::live_browser_sessions tests="tests::live_sessions_are_the_unrevoked_unexpired_ones_newest_first"}}

#### `expire_browser_session`

Ending a same-device session moves its `expires_at` back rather than stamping `revoked_at`. The `expires_at > now` guard never moves a session's expiry later.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::expire_browser_session tests="tests::expiring_a_session_moves_its_expiry_back_to_now"}}

#### `touch_browser_session_last_seen`

When the server accepts a session's cookie it passes `seen_before` as `seen_at` less [`LAST_SEEN_RESOLUTION`](<../Domain/Browser Session Explanation.md#item-LAST_SEEN_RESOLUTION>), so **the column moves at most once per window, and never backwards**. A refresh family rotating passes `seen_at` as `seen_before`, so it moves the column unless the column is already later.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::touch_browser_session_last_seen tests="tests::a_touch_moves_last_seen_only_past_the_guard"}}

#### `is_session_shortfall_acknowledged_for_client`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::is_session_shortfall_acknowledged_for_client}}

#### `record_session_shortfall_acknowledgement`

Continue records it, in the same write as the request's acknowledgement; Cancel records nothing. The `INSERT` does nothing on a primary-key conflict.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::record_session_shortfall_acknowledgement tests="tests::a_session_shortfall_acknowledgement_is_per_session_and_client"}}

#### `delete_browser_sessions_ended_before`

The prune test keeps sessions alive with refresh families built by [`family`](<Test Fixtures Explanation.md#item-browser_sessions--tests--family>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::delete_browser_sessions_ended_before tests="tests::the_prune_takes_only_sessions_ended_before_the_cutoff_that_no_live_family_names"}}
