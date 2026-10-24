# Session Widening

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs self}}

The ask is bound to the [limited page](<Session Shortfall Explanation.md>)'s request: it widens by exactly that request's [`session_shortfall`](<../../Authority/Delegated Scopes Explanation.md#item-session_shortfall>) against the session's row, and keeps the request waiting there as long as the widening waits for the Owner ([`extend_limited_page_wait`](<../../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--extend_limited_page_wait>)), so the browser can go on with it once the Owner has decided. The Owner decides on the widening's card, through the [session widening consents](<../Access/Session Widening Consents Explanation.md>), which widen the session's row. The poll then claims the approval under a [claimed session widening](<../../Authority/Session Widening Explanation.md>) and revokes the token the new one replaces.

## `domain::capabilities::oauth::session_widening`

### `SessionWideningStatus`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWideningStatus}}

### `SessionWideningPollError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWideningPollError}}

### `PolledWidening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs PolledWidening}}

### `SessionWidening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening::new}}

#### `ask`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening::ask tests="tests::an_ask_files_a_widening_for_what_the_session_lacks tests::an_ask_with_nothing_to_widen_finds_no_request"}}

#### `poll`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening::poll tests="tests::the_first_poll_after_approval_collects_the_wider_session tests::a_declined_widening_leaves_the_session_and_only_its_session_polls_it tests::an_undecided_or_orphaned_widening_has_expired"}}

#### `claim_widened_session` and `revoke_replaced_token`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening::claim_widened_session}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs SessionWidening::revoke_replaced_token}}

The tests decide each widening as the Owner, through the real decider, so the poll sees the session's row as an approval leaves it:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs tests::RecordingRevocation}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs tests::Fixture}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs tests::fixture}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs tests::presented_session}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/session_widening.rs tests::owner}}
