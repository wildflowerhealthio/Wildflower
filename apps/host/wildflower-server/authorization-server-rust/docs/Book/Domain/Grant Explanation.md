# Grant

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs}}

A grant is the Owner's standing yes. When the Owner approves an app's request, the server records a grant alongside the one-off approval: "this app may have these scopes, here". **The grant lasts until the Owner revokes it.** Nothing about it expires.

There are two kinds, one per flow that has an Owner to ask. An **authorization-code grant** is keyed on the app and the exact redirect URI it asked from. It is what lets the next request from the same app, at the same redirect, skip the Owner: when a grant already covers every scope a registered app asks for, `/oauth/authorize` issues a code straight away ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/standing_grant.rs GrantCoverage::resolve}}). A grant that covers only some of them pre-ticks those on the consent card. A **device grant** is keyed on the app and the device's name. It is the Owner's record of which devices they have paired; it never skips a prompt.

Revoking a grant ends what it earned. {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/grants.rs GrantsRevoker::revoke}} revokes every access token the app holds, deletes the row, and expires every refresh family issued to the app.

## `AuthorizationCodeGrant`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs AuthorizationCodeGrant}}

| Field                       | The fact it records                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `client_id`, `redirect_uri` | Which app, and where it receives codes. One grant per pair.                                                             |
| `scopes`                    | Everything the Owner has approved for this pair, across every approval (see [`absorb_reapproval`](#absorb_reapproval)). |
| `granted_at`                | The latest approval.                                                                                                    |
| `patient`                   | The patient the latest approval named. A fast-path code carries it.                                                     |
| `last_used_at`              | Nothing stamps it; it stays empty.                                                                                      |

The `id` is a UUID, unique across both kinds, so a bare grant id names one grant whichever table holds it.

## `DeviceGrant`

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs DeviceGrant}}

The same facts, keyed on `device_name` instead of a redirect. The name is the one the device gave itself, or the app's name when it gave none. A refresh family begun by a device's poll records the grant's `id`.

## Test fixtures

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::code_grant}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::device_grant}}

One grant of each kind, for one app, with the same scopes and no patient.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::to_json}}

The JSON the grants endpoints send for a grant.

## `CumulativeConsent`

**Consent only grows.** When the Owner approves an app again at a grant's key, the approval folds into the standing grant instead of replacing it. Approving a narrower request withdraws nothing; revoking the grant is the only way to take scopes back.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs CumulativeConsent}}

## `absorb_reapproval`

A re-approval widens the scopes, moves `granted_at` to the new approval, and adopts its patient, including none. Both kinds implement it the same way:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs AuthorizationCodeGrant::absorb_reapproval}}

{{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs DeviceGrant::absorb_reapproval}} is identical. The widening parses the scopes rather than comparing strings: re-approving `patient/Patient.cruds` over a standing `patient/Patient.r` leaves the one broader scope, not both spellings.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs union_scopes_into}}

The writer reads the standing grant and writes the widened one in a single write scope ({{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/grant_recorder.rs GrantRecorder::record_code_grant}}), so two approvals at once can't both widen the old row and lose one's scopes.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::absorb_reapproval_unions_scopes_and_refreshes_consent}}

The code grant gains `write` after its existing scopes and takes the new patient; the device grant, re-approved for less, keeps both its scopes. Both take the new instant.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::absorb_reapproval_records_one_scope_per_resource_not_two_spellings}}

A broader scope replaces the narrower one in place, and two disjoint interactions on one resource (`.r` then `.s`) are recorded as the one scope granting both (`.rs`).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::absorb_reapproval_of_covered_scopes_leaves_the_list_untouched}}

Re-approving scopes the grant already covers leaves the list exactly as it was.

## `Grant`

The two kinds meet in one enum where a reader needs both: listing the Owner's grants, reading one by id, and the grants endpoints' JSON. The `grantType` tag sits beside each kind's own fields, which is the shape the `access-management` TypeScript schema decodes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs Grant}}

Its two getters, `id` and `client_id`, read the shared fields without unpacking the kind; revocation uses `client_id` to find the app's tokens and families.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs Grant::id Grant::client_id}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::authorization_code_grant_serializes_exactly}}

An authorization-code grant is the whole JSON object above: camelCase fields, `grantType: "authorization_code"`, `redirectUri`, and an absent patient or last use as `null`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/grant.rs tests::device_grant_serializes_exactly}}

A device grant carries `grantType: "device_code"` and `deviceName`, with its patient alongside.
