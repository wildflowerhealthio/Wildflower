# Browser Sessions

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs}}

Two tables hold what the server knows about the browsers it has let in. `browser_sessions` holds one row per [browser session](<../Domain/Browser Session Explanation.md>), keyed by its `sid`, read back as a `BrowserSession`. **A session's row outlives the session.** Revoking it stamps `revoked_at` and keeps the row, because the token verifier and refresh redemption look the `sid` up to refuse what the session minted. The row goes only in the retention sweep.

`BrowserSession` maps onto the row one field to one column of the same name: `sid`, `kind`, `name`, `scopes`, `created_at`, `expires_at`, `revoked_at` and `last_seen_at`. `scopes` is compact JSON text through the shared `JsonStrings`; `kind` is its wire string, `owner` or `approved`, which a `CHECK` constraint on the column also enforces; `name` is `NULL` for the Owner's own browser.

`session_shortfall_acknowledgements` records, per browser session, **the apps it has gone on past its [limited page](<../Domain/Authorization Request Explanation.md#the-limited-page-and-the-race-it-creates>) for**. It has those two columns and no others, and its primary key is the pair (`sid`, `client_id`), so a pair is recorded at most once and a lookup by the pair is a key lookup. Neither table carries a foreign key: `sid` here, and on the requests, codes and refresh-token families that record it, is a soft reference that the retention sweep keeps tidy.

## Test fixtures

`store` opens a fresh, migrated in-memory store:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::store}}

`family` is a refresh-token family for `app`, minted under the session `sid`, expiring at `expires_at`. The prune test uses it to keep a session alive:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::family}}

## `insert_browser_session`

**Record a browser the server just let in**: the Owner's browser signing in, or a paired browser the Owner approved. A plain `INSERT`; a second session with the same `sid` breaks the primary key and the insert fails.

Port: [`insert_browser_session`](<../Grant Store/Browser Sessions Explanation.md#insert_browser_session>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::insert_browser_session}}

No unit test of its own; every test below starts by inserting sessions.

## `browser_session_by_sid`

**The session a `sid` names, revoked or not, or `None` when no row has it.** A primary-key lookup.

Port: [`browser_session_by_sid`](<../Grant Store/Browser Sessions Explanation.md#browser_session_by_sid>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::browser_session_by_sid}}

Exercised with revocation, under [`revoke_browser_session`](#revoke_browser_session).

## `browser_session_is_revoked`

**Whether what a session minted must be refused, without loading the session.** The query asks that no row exists with this `sid` and `revoked_at IS NULL`. A revoked session answers `true`, and so does **a `sid` with no row: a missing session fails closed**.

Port: [`browser_session_is_revoked`](<../Grant Store/Browser Sessions Explanation.md#browser_session_is_revoked>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::browser_session_is_revoked}}

Exercised with revocation, under [`revoke_browser_session`](#revoke_browser_session).

## `revoke_browser_session`

**End a session, once.** The `UPDATE` matches the `sid` only while `revoked_at IS NULL`, and stamps it. **The first revocation's instant is the one kept**: a second revoke matches no row and answers `false`, as does a `sid` with no row. The row itself stays.

Port: [`revoke_browser_session`](<../Grant Store/Browser Sessions Explanation.md#revoke_browser_session>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::revoke_browser_session}}

### What it looks like

A session reads back as inserted, and an unknown `sid` reads as `None`. The session isn't revoked; an unknown `sid` is. The first revoke answers `true` and the second `false`, and the stored `revoked_at` is the first one's. Revoking an unknown `sid` answers `false`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::a_session_round_trips_and_is_revoked_once}}

## `live_browser_sessions`

**The browsers signed in right now, newest first**: the Owner's list of browsers. A session is live when `revoked_at` is `NULL` and `expires_at` is after `now`. The list is ordered by `created_at`, descending.

Port: [`live_browser_sessions`](<../Grant Store/Browser Sessions Explanation.md#live_browser_sessions>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::live_browser_sessions}}

### What it looks like

Of four sessions, the expired one and the revoked one are left out, and the two live ones come back newest first.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::live_sessions_are_the_unrevoked_unexpired_ones_newest_first}}

## `touch_browser_session_last_seen`

**Note that a session was in use, without a write on every request.** The `UPDATE` moves `last_seen_at` to `seen_at` only where it is at or before `seen_before`. When the server accepts a session's cookie, it passes `seen_before` as `seen_at` less [`LAST_SEEN_RESOLUTION`](<../Domain/Browser Session Explanation.md#last_seen_resolution>), so **the column moves at most once per window, and never backwards**: a touch inside the window, or one from before the last, matches no row. A refresh-token family rotating passes `seen_at` as `seen_before`, so it moves the column unless the column is already later. The answer is whether it moved; a `sid` with no row moves nothing.

Port: [`touch_browser_session_last_seen`](<../Grant Store/Browser Sessions Explanation.md#touch_browser_session_last_seen>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::touch_browser_session_last_seen}}

### What it looks like

A touch six minutes after sign-in, with a five-minute window, moves the column. A touch a minute later is inside the window and doesn't. A touch from the sign-in instant is in the past and doesn't. An unknown `sid` doesn't.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::a_touch_moves_last_seen_only_past_the_guard}}

## `session_shortfall_acknowledged_for_client`

**Whether this browser has gone on past its limited page for this app before.** If it has, a new request from it for the app skips the page. The query asks whether the (`sid`, `client_id`) key exists.

Port: [`session_shortfall_acknowledged_for_client`](<../Grant Store/Browser Sessions Explanation.md#session_shortfall_acknowledged_for_client>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::session_shortfall_acknowledged_for_client}}

Exercised with the recording, under [`record_session_shortfall_acknowledgement`](#record_session_shortfall_acknowledgement).

## `record_session_shortfall_acknowledgement`

**Remember that this browser went on past its limited page for this app.** Continue records it, in the same write as the request's acknowledgement; Cancel records nothing. The `INSERT` does nothing on a primary-key conflict, so recording it again is no error and changes nothing.

Port: [`record_session_shortfall_acknowledgement`](<../Grant Store/Browser Sessions Explanation.md#record_session_shortfall_acknowledgement>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::record_session_shortfall_acknowledgement}}

### What it looks like

Nothing is acknowledged at first. After (`sid-1`, `app`) is recorded twice, that pair is acknowledged; the same session for another app isn't, and neither is another session for the same app.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::a_session_shortfall_acknowledgement_is_per_session_and_client}}

## `delete_browser_sessions_ended_before`

**The retention sweep's prune of ended sessions.** [`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>) calls it with the cutoff `now` less [`BROWSER_SESSION_RETENTION`](<../Domain/Retention Explanation.md#browser_session_retention>). It deletes each session that expired, or was revoked, before the cutoff, **unless a refresh-token family alive at the cutoff names it**. A family can outlive its session's expiry, and its refresh must still find the session it was minted under, to check it isn't revoked. The family probe is correlated on `sid`, which `refresh_token_families_sid_idx` answers. The answer is how many sessions went.

A second `DELETE` then removes every limited-page acknowledgement whose `sid` has no session row, so the acknowledgements go with their sessions.

Port: [`delete_browser_sessions_ended_before`](<../Grant Store/Browser Sessions Explanation.md#delete_browser_sessions_ended_before>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs SqliteGrantTx::delete_browser_sessions_ended_before}}

### What it looks like

The cutoff is a day ago. Of five sessions, one expired days ago; one is unexpired but was revoked 29 hours ago; one expired ten hours ago; and two expired days ago, one named by a family alive past now, the other by a family that expired two days ago. The prune takes three: the long-expired one, the revoked one, and the one whose family is dead. The recently expired session and the one a live family names stay. The long-expired session's acknowledgement goes with it; the recent one's stays.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/browser_sessions.rs tests::the_prune_takes_only_sessions_ended_before_the_cutoff_that_no_live_family_names}}
