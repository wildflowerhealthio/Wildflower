# Consents

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/delegation.rs}}

A **consent prompt** is a pending request put to whoever may decide it: the Owner, or an approved browser holding enough. There are two surfaces. The **authorization-code prompt** (`/authorization/oauth-consents/{id}`) is an app asking, through a browser, for access. The **device page's prompt** (`/authorization/devices/{userCode}`) is keyed by the code a device or a browser shows: a device-flow request, or a browser pairing. Each surface can be read, approved and denied; a code-flow prompt can also be raised for the Owner.

This page holds what the two surfaces share: the capabilities, the scopes they take, the shapes the prompt pages read and send, and the deny every path ends in. Each capability's methods live with their flow, on [OAuth Consents](<OAuth Consents Explanation.md>) and [Device Consents](<Device Consents Explanation.md>).

**Approving a request takes its approval scopes**: the power to decide it, and to create what approving it creates. Deciding takes `wildflower/AuthorizationRequest.u`. A code or device approval records a standing grant, so it also takes `wildflower/Grant.c`. A code approval for an app trusted on first use writes the app's registration, so it also takes `wildflower/Client.c` and `wildflower/Client.u`. A code approval also takes the resource scopes the request asks for: its approver must be able to approve it as asked. Which of these a request takes depends on the request, so the decider checks them per call, through the [`DelegatedScopes`](<../../Authority/Delegated Scopes Explanation.md>) proof every approval obtains first. The proof also clamps what the Owner ticked to what the approver holds, so **an approval is never recorded wider than its approver's own authority**.

## `consent_reader_scopes`

Reading a prompt takes `wildflower/AuthorizationRequest.r`. It gates both the reader and the raiser: asking the Owner about a prompt decides nothing, so it takes no more than reading it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs consent_reader_scopes}}

## `consent_decider_scopes`

Deciding a prompt takes `wildflower/AuthorizationRequest.u`. It is the decider's static gate, and the first approval scope of every approval.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs consent_decider_scopes}}

## `grant_creating_approval_scopes`

Approving a code or device request records a standing grant, so it takes `wildflower/Grant.c`. A browser pairing records no grant and doesn't take it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs grant_creating_approval_scopes}}

## `client_registering_approval_scopes`

Approving a code request from an app trusted on first use creates its registration, or widens it in place. **It takes both `wildflower/Client.c` and `wildflower/Client.u`**, whatever the row looks like when the approval lands, so what an approval may write never turns on a race with another approval. An app whose registration is fixed takes neither.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs client_registering_approval_scopes}}

## `ConsentReader`

Read access to a pending prompt: the `GET` side of both surfaces. Its static gate is `wildflower/AuthorizationRequest.r`, and it keeps the reader's own grant, so a prompt it loads says which approval scopes the reader lacks. A browser that can read a prompt but not approve it learns so from the prompt itself.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentReader}}

Its reads are [`oauth_consent`](<OAuth Consents Explanation.md#oauth_consent>) and [`device_consent`](<Device Consents Explanation.md#device_consent>).

## `ConsentRaiser`

What the consent card's "Ask the server's owner" sends. **Raising a prompt decides nothing**: it only stops the request counting as decidable in the browser that made it, so the host notifies the Owner for it. It holds the [`OwnerApproval`](<../../Assembly/Ports and Adapters Explanation.md>) port, to republish the newest pending consent once the change has committed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentRaiser}}

Its one operation is [`raise_for_owner`](<OAuth Consents Explanation.md#raise_for_owner>).

## `OwnerRaising`

What raising did. All three are outcomes the handler answers: `Raised` and `AlreadyRaised` with `204 No Content`, `StartLimited` with the start limit's `429`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs OwnerRaising}}

| Outcome         | What happened                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `Raised`        | The prompt is raised for the Owner now, and the newest pending consent was republished.                |
| `AlreadyRaised` | The prompt wasn't decidable in its requesting browser, so it was already the Owner's. Nothing changed. |
| `StartLimited`  | The authorization start limit refused. The prompt is left as it was.                                   |

## `ConsentDecider`

Approve or deny a pending prompt, on either surface. Its static gate is `wildflower/AuthorizationRequest.u`. It keeps the approver's own grant, which every approval checks the request's approval scopes against and clamps the Owner's ticks to, and the `OwnerApproval` port.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentDecider}}

**Every decision runs in one write scope, and the newest pending consent is republished once it has committed**: the decided request no longer is pending, so the Owner's popup moves on. A decision that fails rolls back and republishes nothing.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentDecider::decide_and_republish}}

Its decisions are [`approve_oauth_consent`](<OAuth Consents Explanation.md#approve_oauth_consent>), [`deny_oauth_consent`](<OAuth Consents Explanation.md#deny_oauth_consent>), [`approve_device_consent`](<Device Consents Explanation.md#approve_device_consent>) and [`deny_device_consent`](<Device Consents Explanation.md#deny_device_consent>).

The three constructors take what the binding lifts from the state and the claims.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentReader::new ConsentRaiser::new ConsentDecider::new}}

## `OAuthConsentView`

What the consent card renders for an authorization-code prompt: the pending request, the app's display name, its [registration verdict](<../../Domain/Client Explanation.md#clientregistrationverdict>), and the approval scopes the reader lacks.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs OAuthConsentView}}

The verdict is worked out from the app's row as it stands at the read, never stored, so a prompt opened after the registration moved shows the move. `missing_approval_scopes` is empty when the reader may approve.

## `DeviceConsentView`

What the device page renders. Device consent is **expandable**: the approver may grant more than the device asked for, up to an envelope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs DeviceConsentView}}

| Field                     | For a device request                                  | For a browser pairing              |
| ------------------------- | ----------------------------------------------------- | ---------------------------------- |
| `client_name`             | the app's name, or its `client_id` when it has no row | the browser-session client's name  |
| `starting_scopes`         | what the device requested                             | everything the reader may delegate |
| `approvable_scopes`       | the app's registered `allowed_scopes`                 | the Owner's scopes                 |
| `missing_approval_scopes` | what the reader lacks, `wildflower/Grant.c` included  | what the reader lacks to decide it |

## `ConsentOutcome`

How a decision ended. `redirect` is the app's callback for a code-flow prompt, so the surface that approved can send the browser on; the device page has none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ConsentOutcome}}

`Denied` covers more than an explicit deny. **An approval that grants nothing is applied as a deny**, and so is an approval of a code request whose browser session has ended or whose app was disabled since. Each is committed. On the code flow, the app hears `access_denied`, with a description saying which.

## `ApproveOAuthConsentInput`

What the Owner sends when approving a code-flow prompt.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ApproveOAuthConsentInput}}

| Field                       | Meaning                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `owner_approved_scopes`     | The scopes the Owner ticked. Clamped to what the prompt may grant.                                                                  |
| `patient`                   | The patient to bind. When the app's SMART launch bound one, it must be that one.                                                    |
| `acknowledged_registration` | The Owner recognises the app and its redirect. Required when the verdict is `New` or `WouldWiden`; ignored when it is `Registered`. |

## `ApproveDeviceConsentInput`

What the approver sends from the device page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs ApproveDeviceConsentInput}}

`device_name` is the approver renaming the device or browser before approving. Left empty, the device's own name is kept.

## `deny_pending_request`

**The one deny**: an explicit deny, an approval that grants nothing, and an approval of a request whose app was disabled since all end here. It denies the request as it was read, inside the caller's write scope, through the guarded replace, so **the deny lands only on a request still pending**. When another surface decided it first, or it expired, nothing changes and the caller's own not-found error comes back, as it does for an approval that loses the same race.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/delegation.rs deny_pending_request}}

It rests on [`deny`](<../../Domain/Authorization Request Explanation.md#deny>) and [`write_transition`](<../../Grant Store/Authorization Requests Explanation.md#write_transition>). No unit test of its own; the deny tests on the two flow pages exercise it.

## Test fixtures

The unit tests for both flows live beside the capabilities, and they are shown on the [OAuth Consents](<OAuth Consents Explanation.md>) and [Device Consents](<Device Consents Explanation.md>) pages under the method each exercises. These are the helpers they share. They build on the shared store fixtures: the fixture app is `client`, its requests ask for `read` at `https://example.com/cb`, and a device request asks for `openid`.

`decider` builds a decider over a clone of the store. The fake shares its tables between clones, so the test arranges and observes rows through its own handle.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::decider}}

`approve_code`, `approve_device_consent` and `deny_device_consent` decide through it. The device deny decides as the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approve_device_consent}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::deny_device_consent}}

`pairing_request` is a pending browser pairing from the browser-session client, asking for the Owner's scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::pairing_request}}

`approved` is the common approval: every scope it names, acknowledged, no patient.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approved}}

`owner_grant` is an approver holding what an Owner holds. `approver_grant_with` is an approved browser holding every approval scope an app trusted on first use takes, plus the resource scopes the test names.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::owner_grant}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::approver_grant_with}}

`live_code_store` is a store with a live browser session, the fixture app registered for `read`, and its pending request `req-1`. `resource_scope_code_store` is the same, with the app registered for and asking for one resource scope.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::live_code_store}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/consents/mod.rs tests::resource_scope_code_store}}
