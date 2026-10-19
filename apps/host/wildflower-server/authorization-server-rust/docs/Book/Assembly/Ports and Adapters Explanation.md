# Ports and Adapters

{{#covers apps/host/wildflower-server/authorization-server-rust/src/ports/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/ports/authorization_start_gate.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/ports/owner_approval.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/ports/revocation.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/adapters/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/adapters/owner_approval.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/adapters/revocation_store.rs}}

A few things the domain must do reach outside the store: **telling the host a request now waits for the Owner**, **revoking and checking tokens** in the revocation store the FHIR server shares, and **asking the host whether a visitor may start another request**. The domain doesn't learn what does these. It calls out through a **port**, a small trait it owns; an **adapter** implements the port on the concrete runtime type. The capabilities hold the ports as trait objects lifted from the state, and their unit tests wire in fakes that record the calls or fail on purpose.

The ports live in `ports/`, bare contracts. Two of the adapters live in `adapters/`; the start gate's real adapter is the host's, since the host is who decides.

## `OwnerApproval`

**Tell the host which request now waits for the Owner.** Any transition that may change which pending request is newest (a new `/oauth/authorize`, `/oauth/device_authorization` or pairing request, a request raised for the Owner, an approval or a denial) calls this after its write, so the host notifies a new request and its server page shows the one pending.

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/owner_approval.rs OwnerApproval}}

The adapter is the shared state itself, so an `Arc<AuthorizationServerState>` is the port handle the capabilities hold. It recomputes the newest pending consent from the store and publishes it on the state's channel:

{{#code apps/host/wildflower-server/authorization-server-rust/src/adapters/owner_approval.rs AuthorizationServerState::republish_active}}

- **The read happens inside `send_if_modified`**, under the channel's lock, so whichever caller commits last to SQLite also publishes last, and the channel never goes back to a request already handled.
- **A publish that changes nothing is suppressed**, so denying an older request leaves the server's status alone.
- **A failed read keeps what the channel holds.** Publishing nothing would tell the host every request it notified is settled, and a passing failure would then re-notify each one still waiting. A request handled meanwhile drops off at the next write or reaper tick.
- **Either way it pings the recompute channel**, so a [`PendingConsentWatcher`](<OAuth Bindings Explanation.md#pendingconsentwatcher>) rereads its request: one decided under a newer request changes nothing on the published channel.

No unit test of its own; [`deciding_an_oauth_consent_clears_the_newest_pending_consent`](<../Integration Tests/OAuth Endpoints Explanation.md#deciding_an_oauth_consent_clears_the_newest_pending_consent>) shows it end to end.

## `Revocation`

**Revoke issued tokens**: denylist one token's `jti` until its expiry, tagged with why, or move a subject's revocation epoch to now, which kills every access and refresh token issued to it before. A grant's revoke, `/authorization/revocations`, logout and an app revoking its own token at `/oauth/revoke` go through it. Errors are strings, so the port doesn't carry the store's error type.

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/revocation.rs Revocation}}

## `RevocationCheck`

**Ask whether a token is revoked**: by its `jti` on the denylist, or by being issued to its subject before the subject's epoch. A missing `jti` skips the first check, a missing issue time the second. The token verifier asks it behind every gate, and so, in-process, the FHIR server's; refresh redemption asks whether a family began before its app's epoch. Every caller **fails closed** on an error.

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/revocation.rs RevocationCheck}}

Both ports have one adapter, the shared revocation store, delegating each call and turning its error into a string:

{{#code apps/host/wildflower-server/authorization-server-rust/src/adapters/revocation_store.rs RevocationStore::revoke_jti}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/adapters/revocation_store.rs RevocationStore::revoke_subject_as_of_now}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/adapters/revocation_store.rs RevocationStore::is_revoked}}

No unit test of their own; [Revocation](<../Integration Tests/Revocation Explanation.md>) holds the store to them end to end.

## `AuthorizationStartGate`

**The host's say over how fast authorization requests start.** `/oauth/authorize` and `/oauth/device_authorization` park requests the Owner is asked about, and a stranger shouldn't be able to raise them without end. The server knows nothing of who is asking beyond the request; the host's listener puts what it knows of the connection in the request's extensions, and the host decides from those. A request it admits has spent from whatever allowance it keeps; one it refuses is answered `429 Too Many Requests`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/authorization_start_gate.rs AuthorizationStartGate}}

When it is asked, and when the asking is deferred until a request is about to be raised for the Owner (including `POST /authorization/oauth-consents/{id}/ask-owner`), is the limit's business, on the [Middleware](<../HTTP/Middleware Explanation.md>) page. The host's own implementation lives outside this crate; it is passed to [`setup_authorization_server`](<Setup Explanation.md#setup_authorization_server>).

## `AdmitEveryAuthorizationStart`

The gate that admits every request, for a server no visitor can reach, and for tests.

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/authorization_start_gate.rs AdmitEveryAuthorizationStart}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/ports/authorization_start_gate.rs AdmitEveryAuthorizationStart::admit}}

No unit test of its own; [Authorization Start Limit](<../Integration Tests/Authorization Start Limit Explanation.md>) drives the limit with gates of its own.
