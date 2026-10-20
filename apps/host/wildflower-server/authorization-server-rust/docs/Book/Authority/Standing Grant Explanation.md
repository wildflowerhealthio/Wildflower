# Standing Grant

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs}}

Once the Owner has approved an app, its next request for the same thing shouldn't ask again. A [standing grant](<../Domain/Grant Explanation.md>) records what the Owner approved for an app at one redirect, and `/oauth/authorize` may issue a code on it **with nobody asked**. That fast path is a code issued with no human in the loop, so it needs a proof of its own.

The Grant page lists [what it takes for a grant to skip the Owner](<../Domain/Grant Explanation.md#when-a-grant-skips-the-owner>). This proof holds the first two: **the request changes nothing in the app's registration, and the standing grant covers every scope it asks for.** However well an old grant covers a request from a new app, at a new redirect or for a new scope, the Owner hasn't seen that combination, so it goes back to them. The other two, the browser session and the launch's patient, are checked by `/oauth/authorize` beside the proof: it takes the fast path only when the request [admits](<../Domain/Authorization Request/Code Request Explanation.md#item-CodeRequest--admits_patient>) the grant's patient, and the code is still [bounded by the browser session](<Delegated Scopes Explanation.md#item-session_bounded_scopes>).

A grant that covers only some of the scopes isn't a proof, but the Owner's earlier yes still counts: the consent card opens with those scopes already ticked.

## `domain::authority::standing_grant`

Each test stores one grant with the [standing-grant fixtures](<Test Fixtures Explanation.md#standing-grant>).

### `GrantCoverage`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage}}

#### `resolve`

The one constructor of the proof. `/oauth/authorize` resolves it in the scope that parks the request, and again when the browser goes on past the limited page.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve tests="tests::full_coverage_is_a_proof_carrying_the_requested_scopes tests::unregistered_requests_and_missing_grants_never_prove"}}

End to end, the [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) tests hold the fast path at the routes: `pre_approved_scopes_skip_consent_on_reauthorize`, `a_narrower_request_is_pre_approved_by_a_broader_standing_grant` and `a_changed_request_never_takes_the_fast_path`.

#### `pre_approved_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::pre_approved_scopes tests="tests::partial_coverage_pre_ticks_without_proving"}}

### `StandingGrantCoverage`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage}}

#### Getters

The request approver's `approve_for_code` reads all three when it issues the code: the scopes and patient to bind, and the grant to stamp used.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage::grant_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage::covered_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs StandingGrantCoverage::patient}}
