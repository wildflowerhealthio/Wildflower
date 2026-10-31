# Session Widening Consents

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs self}}

**A widening's approver may only untick**: [`ApprovableScopes::for_session_widening`](<../../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--for_session_widening>) fills both halves of the clamp with what the browser asked for, bounded by the Owner's scopes, and the [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) clamp also bounds every scope by what the approver holds. The capabilities are declared on [Consents](<Consents Explanation.md>).

## `domain::capabilities::access::consents::session_widening`

### `load_pending_session_widening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs load_pending_session_widening}}

### `ConsentReader`

#### `session_widening_consent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs ConsentReader::session_widening_consent tests="tests::the_card_reads_the_widening_and_what_the_reader_may_tick"}}

### `ConsentDecider`

#### `approve_session_widening`

The approval and the session's growth are the [request approver](<../../Writers/Request Approver Explanation.md#item-RequestApprover--approve_session_widening>)'s.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs ConsentDecider::approve_session_widening tests="tests::approving_widens_the_session_by_the_ticks_and_forgets_the_continues tests::an_approver_widens_by_no_more_than_it_holds tests::a_widening_of_an_ended_session_is_denied"}}

#### `deny_session_widening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs ConsentDecider::deny_session_widening tests="tests::a_decline_leaves_the_session_as_it_was"}}

### `deny_session_widening` and `widening_not_found`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs deny_session_widening}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs widening_not_found}}

The tests store a paired session, gone on past its limited page for two apps, and a widening of it:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs tests::store}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs tests::decider}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs tests::owner}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs tests::session_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/session_widening.rs tests::stored}}
