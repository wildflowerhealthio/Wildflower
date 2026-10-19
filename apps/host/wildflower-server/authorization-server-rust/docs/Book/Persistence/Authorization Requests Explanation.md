# Authorization Requests

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs}}

The `authorization_requests` table holds every [authorization request](<../Domain/Authorization Request Explanation.md>), of all three kinds, one row each, from the moment it parks until the retention sweep takes it. **The row is where the request's single decision is settled.** Two decisions, or Continue and Cancel on the limited page, race to move the same row, and the row's phase decides which lands ([`replace_authorization_request`](#replace_authorization_request)).

What the table's keys and indexes enforce:

| Key or index                                                                                      | What it holds the table to                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| primary key `id`                                                                                  | One row per request: the device's `device_code`, the pairing code, or a code request's UUID. Every read and write by id is a key lookup.                       |
| `authorization_requests_user_code_idx` on `user_code`                                             | The device page's lookups by the code the Owner types or confirms.                                                                                             |
| `authorization_requests_pending_user_code_uidx`, unique on `user_code` where `status = 'pending'` | **At most one pending request per user code.** Decided and claimed rows are outside it, so they may share a code with each other and with one pending request. |

The schema is in the crate's [migrations](../../../migrations/0001_gatekeeper_schema/up.sql); later migrations add the code request's `launch`, `launch_bound_patient`, `sid`, `decidable_in_requesting_browser` and `session_shortfall_acknowledged` columns. No foreign key ties `client_id` to `clients` or `sid` to `browser_sessions`: an app trusted on first use has no `clients` row yet, and a session is pruned on its own schedule.

## One row for three kinds

The row is every kind's columns side by side, mapped as the private `Row`, one field per column of the same name. `grant_type` says which kind the row is; a column another kind owns is `NULL`. A pairing keeps its browser's name in `device_name`, the column the device page reads a requester's name from. `granted_scopes` and `patient` hold the approval, present exactly when the request is approved or claimed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs Row}}

`status` is stored as its wire string (`pending`, `approved`, `denied`, `claimed`), and `grant_type` as its wire string through the mapping in `db::shared`. There is no `expired` status in the table: expiry is read from `expires_at`.

Writing a request fills the columns its kind owns and leaves the rest `NULL`. A device request or a pairing stores `session_shortfall_acknowledged` as `true` and `decidable_in_requesting_browser` as `false`, so **a non-code row's phase is its status alone**, as the domain's phase says:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs Row::from}}

Reading a row back goes the other way, by `grant_type`. **A row missing a column its kind requires fails the read as malformed; it never reads as absent.** A code row needs its redirect, challenge, `state` and `sid`; a device row its user code; a pairing its user code and browser name. The assembled request then goes through [`restore`](<../Domain/Authorization Request Explanation.md#restore>), which refuses an approval that disagrees with the status.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs AuthorizationRequest::try_from}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs malformed_row}}

Every single-row read shares one step, which reads no row as `None`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs restored}}

### What it looks like

**Every kind, in every status, reads back exactly as written.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert_and_fetch_round_trip}}

A code row tampered to lose its redirect or its `sid`, relabelled as a device row (no user code) or a pairing (no browser name), marked approved with no approval, or given an approval while pending: each fails the read.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::a_malformed_row_fails_the_read}}

An unknown `status` or `grant_type` string is a typed read error, not a panic.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::corrupt_enum_columns_are_typed_read_errors}}

## Test fixtures

The round-trip property draws requests of every shape. `arb_scopes` is up to four scope-like strings:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::arb_scopes}}

`arb_kind` draws one of the three kinds with every field it carries, using the shared URL and timestamp strategies from the [Persistence](<../Persistence Explanation.md>) page:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::arb_kind}}

`arb_status_and_approval` draws a status with an approval exactly when the status is approved or claimed, the pairs `restore` accepts:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::arb_status_and_approval}}

`arb_authorization_request` (a `prop_compose!` strategy) puts them together, with an id, a client, scopes and two timestamps drawn independently, through `restore`.

The example tests build their requests with these. `device_request_at` is a pending device request from `device-client` with a chosen user code, start and lifetime; `device_request` is one keyed `UC-<id>`, started now, live five minutes:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::device_request_at}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::device_request}}

`code_request` is a pending code request from `app`, live five minutes, carrying the shared [`fixture_code`](<../Grant Store/Test Fake Explanation.md>), whose browser is past its limited page:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::code_request}}

`insert`, `stored` and `replace` run one store call each and unwrap it; `newest` asks for the newest pending consent now:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::stored}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::replace}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::newest}}

`execute` runs raw SQL, to plant a row no flow writes:

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::execute}}

Some tests also move a fixture to a status with the shared [`with_status`](<../Grant Store/Test Fake Explanation.md>), and register a client with [`client`](<../Grant Store/Test Fake Explanation.md>).

## `authorization_request_by_id`

**The request an id names, or `None`.** The consent card, the limited page, the wait page's status read, and the device's and the pairing's polls all find their request this way. A primary-key lookup; a row that doesn't decode is an error.

Port: [`authorization_request_by_id`](<../Grant Store/Authorization Requests Explanation.md#authorization_request_by_id>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::authorization_request_by_id}}

Exercised by the round trip above, and by every test below, which reads its rows back through it.

## `insert_authorization_request`

**Park a freshly started request.** One `INSERT` of its row. A request whose kind has a user code may collide with the partial unique index, and the insert handles that one way: **a pending row holding the same user code that had expired by the time this request started is deleted first.** It can never be decided, but it still sits in the index. Nothing else is cleared here. Unrelated expired rows wait for the retention sweep, so the retention window alone decides when they go. A pending row with the same code that is still live is never dropped: the insert fails on the index, and the collision is a hard error.

Port: [`insert_authorization_request`](<../Grant Store/Authorization Requests Explanation.md#insert_authorization_request>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::insert_authorization_request}}

### What it looks like

An expired request with another code survives a new insert.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert_leaves_unrelated_expired_requests_for_the_sweep}}

An expired pending request with the same code is replaced by the new one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert_clears_an_expired_row_holding_the_same_user_code}}

A live pending request with the same code makes the insert fail, and stays.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert_never_drops_a_live_row_holding_the_same_user_code}}

A denied request with the same code is outside the index: it neither blocks the insert nor is removed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::insert_leaves_a_decided_row_holding_the_same_user_code}}

## `authorization_request_by_user_code`

**Any request carrying a user code, whatever its status, or `None`.** Starting a device request or a pairing asks this to pick a code no row holds yet: a candidate any row carries is drawn again. The `user_code` index answers it. Several decided rows may share a code, and no order is asked for, so which of them comes back isn't specified; a caller that needs the live request asks the next method instead.

Port: [`authorization_request_by_user_code`](<../Grant Store/Authorization Requests Explanation.md#authorization_request_by_user_code>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::authorization_request_by_user_code}}

No unit test of its own here.

## `pending_authorization_request_by_user_code`

**The pending request for a user code, or `None`**: what the device page decides. The `status = 'pending'` filter keeps a decided row with the same code from shadowing the live one, and the partial unique index makes the answer unique.

Port: [`pending_authorization_request_by_user_code`](<../Grant Store/Authorization Requests Explanation.md#pending_authorization_request_by_user_code>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::pending_authorization_request_by_user_code}}

No unit test of its own here.

## `replace_authorization_request`

**Write a transition, but only if nobody moved the row first.** This is the store's half of the domain's [guarded replace](<../Domain/Authorization Request Explanation.md#the-guarded-replace-first-decision-wins>). One `UPDATE` writes every column but the key from the transitioned request; a column the request leaves empty is written as `NULL`. Its `WHERE` matches the key and the [phase](<../Domain/Authorization Request Explanation.md#requestphase>) the request was read in: the `status`, and the `session_shortfall_acknowledged` flag. **One row affected means the transition landed. None means the row moved on since the read, or isn't there**, and the row is left as it is. A write scope runs in `BEGIN IMMEDIATE`, so two of these never interleave; the second simply finds the phase gone.

Port: [`replace_authorization_request`](<../Grant Store/Authorization Requests Explanation.md#replace_authorization_request>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::replace_authorization_request}}

### What it looks like

**Of two decisions, the first wins.** An approval and a denial are both made from the same pending read. The approval lands and writes the whole approved request; the denial no longer matches and changes nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::a_transition_lands_only_in_the_phase_it_was_read_in}}

**Continue and Cancel on the limited page can't both land.** Both are made from (pending, unacknowledged). Continue lands and moves the flag; Cancel no longer matches, so the request stays pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::a_cancel_racing_a_continue_on_the_limited_page_does_not_land}}

**A poll stamp never undoes an approval.** A stamp leaves the phase as it was, so an approval made from the same read still lands after it. A second stamp from that read, now stale, no longer lands, so it can't write the request back to pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::approvals_never_fight_poll_stamps}}

A transition on a row that isn't there lands nowhere, and creates nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::a_transition_on_a_missing_row_does_not_land}}

## `newest_pending_consent`

**The request the host should tell the Owner about: the newest one still waiting on them.** That is a row that is pending, expires after `now`, and is past its browser's limited page (`session_shortfall_acknowledged`, always set on a device or pairing row), newest `requested_at` first. Its client is joined with a left join on `clients`, for two reasons. **A disabled client's request is skipped**: the join's `disabled_at` must be `NULL`. **A client with no row stays a candidate**, since the left join gives it a `NULL` `disabled_at` too; it is an app trusted on first use, awaiting its first approval. The join also brings the registered name, which [`for_request`](<../Domain/Pending Consent Explanation.md#for_request>) uses, falling back to the `client_id` when there is none. No index covers `status` or `requested_at`.

Port: [`newest_pending_consent`](<../Grant Store/Authorization Requests Explanation.md#newest_pending_consent>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::newest_pending_consent}}

### What it looks like

Each newer request of a different kind becomes the answer: a device request, then a code request, then a pairing. An unregistered client is named by its `client_id`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::newest_pending_consent_picks_the_newest_request_across_every_kind}}

An expired request, an approved one, a denied one and one still on its limited page leave no answer.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::newest_pending_consent_skips_what_no_longer_waits_for_the_owner}}

A newer request from a disabled client is skipped, and the older device request from a client with no row is the answer.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::newest_pending_consent_skips_a_disabled_client}}

A registered client is named by its registered name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::newest_pending_consent_names_a_registered_client_by_its_name}}

## `delete_authorization_requests_expired_before`

**The retention sweep's prune of requests.** [`purge_expired`](<../Domain/Retention Explanation.md#purge_expired>) calls it with the cutoff `now` less [`AUTHORIZATION_RETENTION`](<../Domain/Retention Explanation.md#authorization_retention>). It deletes every row whose `expires_at` is before the cutoff, **whatever its status**, and answers how many went. Past its expiry a request is no longer decided or claimed, so the window only bounds how long the row is kept.

Port: [`delete_authorization_requests_expired_before`](<../Grant Store/Authorization Requests Explanation.md#delete_authorization_requests_expired_before>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs SqliteGrantTx::delete_authorization_requests_expired_before}}

### What it looks like

With the cutoff seven days ago, a pending request and a claimed one that expired ten days ago both go; a live one stays.

{{#code apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests.rs tests::delete_expired_requests_respects_the_cutoff}}
