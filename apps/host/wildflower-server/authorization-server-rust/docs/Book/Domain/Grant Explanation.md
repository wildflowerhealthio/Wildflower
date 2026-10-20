# Grant

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs}}

A grant is the Owner's standing yes. When the Owner approves an app's request, the server records a grant alongside the one-off approval: "this app may have these scopes, here". **The grant lasts until the Owner revokes it.** Nothing about it expires.

There are two kinds, one per flow that has an Owner to ask. An **authorization-code grant** is keyed on the app and the exact redirect URI it asked from. A **device grant** is keyed on the app and the device's name. It is the Owner's record of which devices they have paired, and it never skips a prompt.

## When a grant skips the Owner

A later request from the same app, at the same redirect, may get its code at `/oauth/authorize` without asking the Owner. That takes all of these at once:

- **The request changes nothing in the app's registration**: its [presented client change](<Client Explanation.md#item-PresentedClientChange>) is `NoChange`. A new app, a new redirect or a new scope always goes back to the Owner, however much an old grant covers.
- **The standing grant [covers](<Scopes Explanation.md#item-allowed_scope_covers>) every requested scope.** A grant that covers only some of them pre-ticks those on the consent card, and the Owner decides the rest.
- **The request's [browser session](<Browser Session Explanation.md>) holds what the request needs**, or has gone on past its limited page for this app before, so the request isn't waiting there. The code then carries only what the session also covers.
- **A launch's patient, if it bound one, is the grant's patient.** Otherwise the Owner decides.

The proof that the first two hold is {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}; the request's limited page is on the [Code Request](<Authorization Request/Code Request Explanation.md>) page. A code issued this way stamps the grant's `last_used_at`. A device grant's is stamped instead when a refresh family it earned rotates.

Revoking a grant ends what it earned. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}} revokes every access token the app holds, deletes the row, and expires every refresh family issued to the app.

## `domain::grant`

### `AuthorizationCodeGrant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs AuthorizationCodeGrant}}

### `DeviceGrant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs DeviceGrant}}

### `CumulativeConsent`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs CumulativeConsent}}

#### For an authorization-code grant

The writer reads the standing grant and writes the widened one in a single write scope ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant}}), so two approvals at once can't both widen the old row and lose one's scopes. The tests start from the [grant fixtures](<Test Fixtures Explanation.md#grant>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs AuthorizationCodeGrant::absorb_reapproval tests="tests::absorb_reapproval_unions_scopes_and_refreshes_consent tests::absorb_reapproval_records_one_scope_per_resource_not_two_spellings tests::absorb_reapproval_of_covered_scopes_leaves_the_list_untouched"}}

#### For a device grant

The same rule, the same way.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs DeviceGrant::absorb_reapproval}}

### `union_scopes_into`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs union_scopes_into}}

### `Grant`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs Grant tests="tests::authorization_code_grant_serializes_exactly tests::device_grant_serializes_exactly"}}

#### `id` and `client_id`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs Grant::id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs Grant::client_id}}
