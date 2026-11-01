# Request Approver

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs}}

The request approver moves a pending [authorization request](<../Domain/Authorization Request Explanation.md>) to approved, through the flow's own transition ([code](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--to_approved>), [device](<../Domain/Authorization Request/Polled Requests Explanation.md#item-DeviceRequest--to_approved>), [pairing](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--to_approved>)) written with the [guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>). For the code flow it also issues the [authorization code](<../Domain/Authorization Code Explanation.md>) the app redeems at `/oauth/token`.

**The scopes a request records are exactly the proof's**, never a list the flow put together. A device request and a browser pairing are approved on [delegated scopes](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes>): the approver's ticks, clamped to what it may delegate. A code request may also be approved with no one at the prompt, on a [standing grant](<../Authority/Standing Grant Explanation.md#item-StandingGrantCoverage>) that already covers it, so it takes either of two proofs.

**A code is bound to the browser session the request was made in, not the approver's.** The Owner may approve from another browser, but revoking the browser the app runs in still ends what the code starts, and the code carries only what that browser holds ([`session_bounded_scopes`](<../Authority/Delegated Scopes Explanation.md#item-session_bounded_scopes>)).

## `domain::capabilities::writers::request_approver`

The tests park requests and approve them with the [request-approver fixtures](<Test Fixtures Explanation.md#request-approver>).

### `CodeAuthority`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority}}

#### `authorized_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeAuthority::authorized_scopes}}

### `CodeApproval`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs CodeApproval}}

### `RequestApprover`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover}}

#### `within`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::within}}

#### `approve_for_code`

The session is checked with [`is_live_at`](<../Domain/Browser Session Explanation.md#item-BrowserSession--is_live_at>), under the stale-session cutoff, and the code lives for [`AUTHORIZATION_CODE_TTL`](<../Domain/Authorization Code Explanation.md#item-AUTHORIZATION_CODE_TTL>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_code tests="tests::approve_for_code_records_the_proofs_scopes_on_request_and_code tests::approve_for_code_stamps_only_the_standing_grant_it_issues_under tests::approve_for_code_issues_nothing_when_the_request_is_no_longer_pending tests::approve_for_code_denies_a_request_whose_browser_session_has_ended tests::approve_for_code_bounds_the_code_by_the_request_s_browser_session"}}

End to end, the [Session Required](<../Integration Tests/Session Required Explanation.md>), [Browser Sessions](<../Integration Tests/Browser Sessions Explanation.md>) and [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) tests hold the same at the routes: the code names the requesting browser's session, an Owner approval from another browser is bounded by it, a request whose session was revoked is denied, and a standing grant issues a code with nobody asked.

#### `approve_for_device`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_for_device tests="tests::approve_for_device_records_scopes_and_name_only_while_pending"}}

End to end, the [Device Code](<../Integration Tests/Device Code Explanation.md>) tests hold the approval's patient and the approver's rename of the device.

#### `approve_browser_pairing`

**The approval starts no session.** The paired session starts when the pairing page's poll [claims](<../Authority/Browser Pairing Explanation.md#item-ClaimedBrowserPairing--claim>) the approved request. It has no unit test of its own; the [Browser Pairing](<../Integration Tests/Browser Pairing Explanation.md>) tests hold it end to end.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_browser_pairing}}

#### `approve_session_widening`

**The approval widens the session in the same scope**, and never shrinks it: the session keeps its `sid`, its expiry and everything minted under it. The browser's wider token comes later, when the limited page's poll [claims](<../Authority/Session Widening Explanation.md#item-ClaimedSessionWidening--claim>) the approved widening. The [session widening consents](<../Capabilities/Access/Session Widening Consents Explanation.md>) tests hold it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs SessionWideningOutcome}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/request_approver.rs RequestApprover::approve_session_widening}}

Both approvals that run under a browser session, a code's and a widening's, first load it live through the port's [`live_browser_session`](<../Grant Store/Browser Sessions Explanation.md#item-BrowserSessionsTx>): a request whose session has ended is denied, never approved, each writing its own deny.
