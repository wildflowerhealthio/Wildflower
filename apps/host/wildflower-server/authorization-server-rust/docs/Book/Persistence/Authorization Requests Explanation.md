# Authorization Requests

{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/code_request_row.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/session_widening_request_row.rs}}

The [authorization requests](<../Domain/Authorization Request Explanation.md>) live in three tables, by how a request is keyed. `code_authorization_requests` holds the [code requests](<../Domain/Authorization Request/Code Request Explanation.md>), keyed by id. `user_code_requests` holds the [device requests and browser pairings](<../Domain/Authorization Request/Polled Requests Explanation.md>), keyed by the poller's secret, found by the `user_code` the Owner enters, and told apart by a `flow` column. Only this module knows those two flows share a table. `session_widening_requests` holds the [session widenings](<../Domain/Authorization Request/Session Widening Explanation.md>), keyed by id.

**A decision lands once.** Every write of a transition is the flow's guarded replace: one `UPDATE` of the whole row, guarded on the key and the status the request was read with, so of two transitions read from one row the first to land wins and the other matches nothing ([the guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>)). **At most one pending request holds a `user_code`**: a partial unique index holds it, and a request decided or claimed is outside the index.

**A row is checked against its flow and status on the way in.** Each table's row type reads into the flow's struct through one conversion, the one place the columns are held against the flow and status; the table's `CHECK`s refuse the same rows on write. A row whose approval disagrees with its status, or that lacks a column its flow requires, fails the read as malformed rather than reading as absent.

The tests' requests are built by the helpers on the [Test Fixtures](<Test Fixtures Explanation.md#authorization-requests>) page.

## `db::authorization_requests::code_request_row`

### `CodeAuthorizationRequestRow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/code_request_row.rs CodeAuthorizationRequestRow}}

#### Into a `CodeRequest`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/code_request_row.rs CodeRequest::try_from}}

## `db::authorization_requests::user_code_request_row`

### `UserCodeRequestRow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs UserCodeRequestRow}}

#### Into a `DeviceRequest`, a `PairingRequest` or either

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs UserCodeRequestRow::require_flow}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs UserCodeRequestRow::take_state}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs DeviceRequest::try_from}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs PairingRequest::try_from}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/user_code_request_row.rs PolledRequest::try_from}}

## `db::authorization_requests::session_widening_request_row`

### `SessionWideningRequestRow`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/session_widening_request_row.rs SessionWideningRequestRow}}

#### Into a `SessionWideningRequest`

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/session_widening_request_row.rs SessionWideningRequestRow::malformed}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/session_widening_request_row.rs SessionWideningRequest::try_from}}

## `db::authorization_requests`

### `approval_from_columns`

The conversions read the approval through it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs approval_from_columns tests="tests::a_malformed_row_fails_the_read tests::corrupt_enum_columns_are_typed_read_errors"}}

### `impl AuthorizationRequestsTx for SqliteGrantTx`

The port is [`AuthorizationRequestsTx`](<../Grant Store/Authorization Requests Explanation.md#item-AuthorizationRequestsTx>).

#### Loading a request

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::authorization_request_by_id tests="tests::insert_and_fetch_round_trip tests::each_flow_s_loader_reads_only_its_own_flow"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::user_code_request_by_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::session_widening_request_by_id}}

A session's widenings still waiting for the Owner are what a repeated ask answers with, and what revoking the session denies.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::pending_session_widening_requests_for_session tests="tests::pending_session_widenings_are_the_session_s_undecided_unexpired_ones"}}

#### Inserting a request

Bulk reclamation of expired rows is the retention sweep's, so an insert leaves an unrelated expired row alone. The one row it clears is an expired pending one holding the new request's `user_code`, which would otherwise hold the slot in the partial unique index.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::insert_user_code_row tests="tests::insert_leaves_unrelated_expired_requests_for_the_sweep tests::insert_clears_an_expired_row_holding_the_same_user_code tests::insert_never_drops_a_live_row_holding_the_same_user_code tests::insert_leaves_a_decided_row_holding_the_same_user_code"}}

#### The guarded replace

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::replace_code_request tests="tests::a_replace_lands_only_while_the_row_has_the_status_it_was_read_with tests::a_cancel_racing_a_continue_on_the_limited_page_does_not_land tests::a_replace_on_a_missing_or_another_row_does_not_land"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::replace_user_code_row tests="tests::approvals_never_fight_poll_stamps"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::replace_session_widening_request}}

#### `owner_prompt`

The one request the host notifies about and opens: the [Owner prompt](<../Domain/Owner Prompt Explanation.md>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::owner_prompt tests="tests::owner_prompt_picks_the_newest_request_across_every_flow tests::owner_prompt_skips_what_does_not_wait_for_the_owner tests::owner_prompt_skips_a_disabled_client tests::owner_prompt_breaks_a_tie_deterministically tests::owner_prompt_names_a_registered_client_by_its_name"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::newest_pending_code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::newest_pending_user_code_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::newest_pending_session_widening_request}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs PromptCandidate}}

#### `is_awaiting_owner`

Whether the consent the host holds open is still undecided.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::is_awaiting_owner tests="tests::is_awaiting_owner::a_request_awaits_the_owner_until_it_is_decided_or_expires tests::is_awaiting_owner::a_disabled_client_s_request_does_not_await_the_owner"}}

#### The retention deletes

The cutoff is the sweep's, [`purge_expired`](<../Domain/Retention Explanation.md#item-purge_expired>) with [`AUTHORIZATION_RETENTION`](<../Domain/Retention Explanation.md#item-AUTHORIZATION_RETENTION>), so an expired request is kept a while before it goes.

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::delete_code_requests_expired_before tests="tests::delete_expired_requests_respects_the_cutoff"}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::delete_polled_requests_expired_before}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/db/authorization_requests/mod.rs SqliteGrantTx::delete_session_widening_requests_expired_before}}
